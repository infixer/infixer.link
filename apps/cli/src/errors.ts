/** Exit codes (design §13.1: meaningful exit codes for scripts). */
export const EXIT = {
	ok: 0,
	error: 1,
	usage: 2,
	notFound: 3,
	conflict: 4,
	auth: 5,
	network: 6
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
	readonly exitCode: ExitCode;
	/** API error code, when the server returned one. */
	readonly code: string | undefined;

	constructor(message: string, exitCode: ExitCode = EXIT.error, code?: string) {
		super(message);
		this.exitCode = exitCode;
		this.code = code;
	}
}
