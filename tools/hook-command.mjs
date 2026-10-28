import { Buffer } from 'node:buffer';

/** Paths travel as encoded argv, never as executable shell text. */
export function commandHook(args, node = process.execPath) {
  const payload = Buffer.from(JSON.stringify({ node, args })).toString('base64');
  const expression = `const c=JSON.parse(Buffer.from('${payload}','base64'));const r=require('node:child_process').spawnSync(c.node,c.args,{stdio:'inherit'});process.exit(r.status??1)`;
  const unixNode = `'${node.replaceAll("'", "'\\''")}'`;
  const windowsScript = `& '${node.replaceAll("'", "''")}' -e '${expression.replaceAll("'", "''")}'`;
  return { type: 'command', command: `${unixNode} -e "${expression}"`,
    commandWindows: `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(windowsScript, 'utf16le').toString('base64')}`, timeout: 3 };
}
