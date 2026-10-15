/**
 * Operator command: mint a one-time setup / recovery code (design §9.2, §9.5).
 *
 * Requires the same Cloudflare rights as `wrangler d1 execute`, which is what makes
 * it an operator-only path. The code is printed once; only its hash is stored.
 *
 *   node scripts/owner-grant.ts                       # local D1, purpose=setup
 *   node scripts/owner-grant.ts --purpose recovery
 *   node scripts/owner-grant.ts --remote --env staging
 *   node scripts/owner-grant.ts --persist-to .wrangler/e2e --json
 */
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { mintGrant, GRANT_TTL_MS, type GrantPurpose } from '../src/lib/server/auth/grants.ts';

const { values } = parseArgs({
	options: {
		purpose: { type: 'string', default: 'setup' },
		remote: { type: 'boolean', default: false },
		env: { type: 'string' },
		'persist-to': { type: 'string' },
		json: { type: 'boolean', default: false }
	}
});

const purpose = values.purpose as GrantPurpose;
if (purpose !== 'setup' && purpose !== 'recovery') {
	console.error('--purpose must be "setup" or "recovery"');
	process.exit(2);
}

const grant = await mintGrant(purpose, Date.now());
const args = ['exec', 'wrangler', 'd1', 'execute', 'DB', values.remote ? '--remote' : '--local'];
if (values.env) args.push('--env', values.env);
if (values['persist-to']) args.push('--persist-to', values['persist-to']);
args.push('--command', grant.statements.join(';\n'));

try {
	execFileSync('pnpm', args, { stdio: ['ignore', 'ignore', 'inherit'] });
} catch {
	console.error('Failed to store the grant with wrangler d1 execute.');
	process.exit(1);
}

if (values.json) {
	console.log(
		JSON.stringify({ purpose, token: grant.token, expiresInSeconds: GRANT_TTL_MS / 1000 })
	);
} else {
	console.log(`${purpose} code (valid for ${GRANT_TTL_MS / 60000} minutes, single use):\n`);
	console.log(`  ${grant.token}\n`);
	console.log('Open /owner/setup on the site and paste the code. Do not share it.');
}
