import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function GET() {
	const { stdout } = await execFileAsync(process.execPath, ['-e', "process.stdout.write('container-runtime-ok')"]);
	return Response.json({ runtime: stdout });
}
