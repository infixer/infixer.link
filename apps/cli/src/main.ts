#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/** Entry point of the `infixer` command (the logic is in cli.ts, which tests import). */
import { run } from './cli.ts';
import { CliError, EXIT } from './errors.ts';

run(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		if (error instanceof CliError) {
			process.stderr.write(`infixer: ${error.message}\n`);
			process.exit(error.exitCode);
		}
		const message = error instanceof Error ? error.message : String(error);
		// parseArgs: unknown option / missing value
		if (
			error instanceof TypeError &&
			'code' in error &&
			String(error.code).startsWith('ERR_PARSE_ARGS')
		) {
			process.stderr.write(`infixer: ${message}\n`);
			process.exit(EXIT.usage);
		}
		process.stderr.write(`infixer: 予期しないエラー: ${message}\n`);
		process.exit(EXIT.error);
	}
);
