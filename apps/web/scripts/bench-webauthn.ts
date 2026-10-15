/**
 * Rough CPU-cost estimate of passkey verification on V8 (Node), used as a proxy
 * for Workers CPU time until it can be measured on staging (design §3, Phase 0).
 * Usage: node scripts/bench-webauthn.ts
 */
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse
} from '@simplewebauthn/server';
import { SoftAuthenticator } from '../tests/helpers/soft-authenticator.ts';

const RP_ID = 'infixer.link';
const ORIGIN = 'https://infixer.link';
const N = 200;

const auth = await SoftAuthenticator.create();
const regOptions = await generateRegistrationOptions({
	rpName: 'bench',
	rpID: RP_ID,
	userName: 'owner',
	attestationType: 'none'
});
const reg = await auth.register({
	challenge: regOptions.challenge,
	rpId: RP_ID,
	origin: ORIGIN,
	userHandle: regOptions.user.id
});

const regTimes: number[] = [];
let credential;
for (let i = 0; i < 20; i++) {
	const t = performance.now();
	const v = await verifyRegistrationResponse({
		response: reg,
		expectedChallenge: regOptions.challenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID
	});
	regTimes.push(performance.now() - t);
	credential = v.registrationInfo!.credential;
}

const authTimes: number[] = [];
for (let i = 0; i < N; i++) {
	const options = await generateAuthenticationOptions({ rpID: RP_ID });
	const response = await auth.authenticate({
		challenge: options.challenge,
		rpId: RP_ID,
		origin: ORIGIN
	});
	const t = performance.now();
	await verifyAuthenticationResponse({
		response,
		expectedChallenge: options.challenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID,
		credential: { ...credential!, counter: 0 }
	});
	authTimes.push(performance.now() - t);
}

const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2);
	return `median ${p(0.5)}ms p95 ${p(0.95)}ms max ${s.at(-1)!.toFixed(2)}ms (n=${s.length})`;
};
console.log(`node ${process.version}`);
console.log(`verifyRegistrationResponse:   ${stats(regTimes)}`);
console.log(
	`verifyAuthenticationResponse: ${stats(authTimes)} (first call ${authTimes[0].toFixed(2)}ms)`
);
