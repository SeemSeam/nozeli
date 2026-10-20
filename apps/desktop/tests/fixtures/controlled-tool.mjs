import { writeFile } from 'node:fs/promises';

const start = process.argv[process.argv.indexOf('--start') + 1];
const late = process.argv[process.argv.indexOf('--late') + 1];
await writeFile(start, 'started');
await new Promise((resolve) => setTimeout(resolve, 500));
await writeFile(late, 'late');
