// Interactive PTYs advertise their own display capabilities, independent of
// the automation/logging environment that happened to launch the desktop app.
export function terminalEnvironment(base=process.env,overrides={}) {
 const env={...base,...overrides,TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'Nozeli',CLICOLOR:'1'};
 delete env.NO_COLOR;delete env.FORCE_COLOR;delete env.CLICOLOR_FORCE;
 return env;
}
