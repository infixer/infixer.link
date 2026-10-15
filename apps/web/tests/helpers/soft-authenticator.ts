/**
 * Minimal software WebAuthn authenticator (ES256, attestation "none") for tests.
 * Produces responses in the JSON shape that @simplewebauthn/browser sends,
 * so the server-side verification can be exercised inside workerd without a browser.
 *
 * Test-only. Never import from application code.
 */
import { isoBase64URL } from '@simplewebauthn/server/helpers';

type Bytes = Uint8Array<ArrayBuffer>;
type CborValue = number | string | Bytes | Map<CborValue, CborValue> | { [key: string]: CborValue };

function concat(...parts: Bytes[]): Bytes {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

function cborHead(major: number, length: number): Bytes {
	if (length < 24) return Uint8Array.of((major << 5) | length);
	if (length < 0x100) return Uint8Array.of((major << 5) | 24, length);
	if (length < 0x10000) return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
	throw new Error('CBOR length too large for this test encoder');
}

function cborEncode(value: CborValue): Bytes {
	if (typeof value === 'number') {
		return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
	}
	if (typeof value === 'string') {
		const bytes = new TextEncoder().encode(value);
		return concat(cborHead(3, bytes.length), bytes);
	}
	if (value instanceof Uint8Array) {
		return concat(cborHead(2, value.length), value);
	}
	const entries: [CborValue, CborValue][] =
		value instanceof Map
			? [...value.entries()]
			: (Object.entries(value) as [CborValue, CborValue][]);
	return concat(
		cborHead(5, entries.length),
		...entries.flatMap(([k, v]) => [cborEncode(k), cborEncode(v)])
	);
}

async function sha256(data: Bytes): Promise<Bytes> {
	return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** WebCrypto returns raw r||s; WebAuthn ES256 signatures are DER encoded. */
function rawEcdsaToDer(raw: Bytes): Bytes {
	const integer = (bytes: Bytes): Bytes => {
		let i = 0;
		while (i < bytes.length - 1 && bytes[i] === 0) i++;
		let v = bytes.slice(i);
		if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
		return concat(Uint8Array.of(0x02, v.length), v);
	};
	const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
	return concat(Uint8Array.of(0x30, body.length), body);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface SoftAuthenticatorOptions {
	/** Set false to simulate an authenticator that skipped user verification. */
	userVerified?: boolean;
}

export class SoftAuthenticator {
	readonly credentialId = crypto.getRandomValues(new Uint8Array(32));
	private keyPair!: CryptoKeyPair;
	private signCount = 0;
	private userHandle?: string;

	static async create(): Promise<SoftAuthenticator> {
		const auth = new SoftAuthenticator();
		auth.keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify'
		])) as CryptoKeyPair;
		return auth;
	}

	get credentialIdBase64URL(): string {
		return isoBase64URL.fromBuffer(this.credentialId);
	}

	private async cosePublicKey(): Promise<Bytes> {
		const jwk = await crypto.subtle.exportKey('jwk', this.keyPair.publicKey);
		return cborEncode(
			new Map<CborValue, CborValue>([
				[1, 2], // kty: EC2
				[3, -7], // alg: ES256
				[-1, 1], // crv: P-256
				[-2, isoBase64URL.toBuffer(jwk.x!)],
				[-3, isoBase64URL.toBuffer(jwk.y!)]
			])
		);
	}

	private flags(opts: SoftAuthenticatorOptions, extra = 0): number {
		return FLAG_UP | (opts.userVerified === false ? 0 : FLAG_UV) | extra;
	}

	private clientData(type: string, challenge: string, origin: string): Bytes {
		return new TextEncoder().encode(
			JSON.stringify({ type, challenge, origin, crossOrigin: false })
		);
	}

	async register(
		params: { challenge: string; rpId: string; origin: string; userHandle: string },
		opts: SoftAuthenticatorOptions = {}
	) {
		this.userHandle = params.userHandle;
		const clientDataJSON = this.clientData('webauthn.create', params.challenge, params.origin);
		const authData = concat(
			await sha256(new TextEncoder().encode(params.rpId)),
			Uint8Array.of(this.flags(opts, FLAG_AT)),
			new Uint8Array(4), // signCount 0
			new Uint8Array(16), // AAGUID
			Uint8Array.of(this.credentialId.length >> 8, this.credentialId.length & 0xff),
			this.credentialId,
			await this.cosePublicKey()
		);
		const attestationObject = cborEncode({ fmt: 'none', attStmt: {}, authData });
		return {
			id: this.credentialIdBase64URL,
			rawId: this.credentialIdBase64URL,
			type: 'public-key' as const,
			response: {
				clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
				attestationObject: isoBase64URL.fromBuffer(attestationObject),
				transports: ['internal' as const]
			},
			clientExtensionResults: {}
		};
	}

	async authenticate(
		params: { challenge: string; rpId: string; origin: string },
		opts: SoftAuthenticatorOptions = {}
	) {
		this.signCount += 1;
		const clientDataJSON = this.clientData('webauthn.get', params.challenge, params.origin);
		const authenticatorData = concat(
			await sha256(new TextEncoder().encode(params.rpId)),
			Uint8Array.of(this.flags(opts)),
			Uint8Array.of(
				(this.signCount >>> 24) & 0xff,
				(this.signCount >>> 16) & 0xff,
				(this.signCount >>> 8) & 0xff,
				this.signCount & 0xff
			)
		);
		const signed = concat(authenticatorData, await sha256(clientDataJSON));
		const raw = new Uint8Array(
			await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keyPair.privateKey, signed)
		);
		return {
			id: this.credentialIdBase64URL,
			rawId: this.credentialIdBase64URL,
			type: 'public-key' as const,
			response: {
				clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
				authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
				signature: isoBase64URL.fromBuffer(rawEcdsaToDer(raw)),
				userHandle: this.userHandle
			},
			clientExtensionResults: {}
		};
	}
}
