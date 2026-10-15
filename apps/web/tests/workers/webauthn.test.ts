/**
 * Phase 0 compatibility check: @simplewebauthn/server runs inside workerd
 * (Web Crypto, CBOR, COSE) and rejects the cases design §9.3 requires.
 */
import { describe, expect, it } from 'vitest';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type WebAuthnCredential
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { SoftAuthenticator } from '../helpers/soft-authenticator';

const RP_ID = 'infixer.link';
const ORIGIN = 'https://infixer.link';

async function registerOwner() {
	const authenticator = await SoftAuthenticator.create();
	const options = await generateRegistrationOptions({
		rpName: 'Personal Garden',
		rpID: RP_ID,
		userName: 'owner',
		attestationType: 'none',
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
	});
	const response = await authenticator.register({
		challenge: options.challenge,
		rpId: RP_ID,
		origin: ORIGIN,
		userHandle: options.user.id
	});
	const verification = await verifyRegistrationResponse({
		response,
		expectedChallenge: options.challenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID,
		requireUserVerification: true
	});
	expect(verification.verified).toBe(true);
	const info = verification.registrationInfo!;
	const credential: WebAuthnCredential = {
		id: info.credential.id,
		publicKey: info.credential.publicKey,
		counter: info.credential.counter,
		transports: info.credential.transports
	};
	return { authenticator, credential, userHandle: options.user.id };
}

async function login(
	authenticator: SoftAuthenticator,
	credential: WebAuthnCredential,
	overrides: { origin?: string; rpId?: string; userVerified?: boolean; tamper?: boolean } = {}
) {
	const options = await generateAuthenticationOptions({
		rpID: RP_ID,
		userVerification: 'required'
	});
	const response = await authenticator.authenticate(
		{
			challenge: options.challenge,
			rpId: overrides.rpId ?? RP_ID,
			origin: overrides.origin ?? ORIGIN
		},
		{ userVerified: overrides.userVerified }
	);
	if (overrides.tamper) {
		const sig = isoBase64URL.toBuffer(response.response.signature);
		sig[sig.length - 1] ^= 0xff;
		response.response.signature = isoBase64URL.fromBuffer(sig);
	}
	return verifyAuthenticationResponse({
		response,
		expectedChallenge: options.challenge,
		expectedOrigin: ORIGIN,
		expectedRPID: RP_ID,
		credential,
		requireUserVerification: true
	});
}

describe('SimpleWebAuthn in workerd', () => {
	it('discoverable login options do not enumerate credential IDs', async () => {
		const options = await generateAuthenticationOptions({
			rpID: RP_ID,
			userVerification: 'required'
		});
		expect(options.allowCredentials ?? []).toHaveLength(0);
		expect(options.userVerification).toBe('required');
	});

	it('registers and authenticates an ES256 passkey', async () => {
		const { authenticator, credential, userHandle } = await registerOwner();
		const result = await login(authenticator, credential);
		expect(result.verified).toBe(true);
		expect(result.authenticationInfo.userVerified).toBe(true);
		expect(result.authenticationInfo.newCounter).toBe(1);
		expect(userHandle).toBeTruthy();
	});

	it('rejects a wrong origin', async () => {
		const { authenticator, credential } = await registerOwner();
		await expect(
			login(authenticator, credential, { origin: 'https://evil.example' })
		).rejects.toThrow();
	});

	it('rejects a wrong RP ID hash', async () => {
		const { authenticator, credential } = await registerOwner();
		await expect(login(authenticator, credential, { rpId: 'evil.example' })).rejects.toThrow();
	});

	it('rejects missing user verification', async () => {
		const { authenticator, credential } = await registerOwner();
		await expect(login(authenticator, credential, { userVerified: false })).rejects.toThrow();
	});

	it('rejects a tampered signature', async () => {
		const { authenticator, credential } = await registerOwner();
		const result = await login(authenticator, credential, { tamper: true }).catch(() => ({
			verified: false
		}));
		expect(result.verified).toBe(false);
	});

	it('rejects a response signed for a different challenge', async () => {
		const { authenticator, credential } = await registerOwner();
		const response = await authenticator.authenticate({
			challenge: isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32))),
			rpId: RP_ID,
			origin: ORIGIN
		});
		const options = await generateAuthenticationOptions({ rpID: RP_ID });
		await expect(
			verifyAuthenticationResponse({
				response,
				expectedChallenge: options.challenge,
				expectedOrigin: ORIGIN,
				expectedRPID: RP_ID,
				credential,
				requireUserVerification: true
			})
		).rejects.toThrow();
	});
});
