/**
 * Simulated shell backend. Stands in for the WebSocket broker stream —
 * swap `respond()` for a socket write when the backend is wired up.
 */

export interface ShellContext {
  user: string;
  hostname: string;
  cwd: string;
}

const FS: Record<string, string[]> = {
  "/": ["bin", "etc", "home", "opt", "root", "tmp", "usr", "var"],
  "/home": ["deploy", "svc-pam"],
  "/etc": ["hostname", "hosts", "ssh/", "pam_agent.conf"],
  "/opt": ["pam-agent"],
  "/var": ["log"],
  "/var/log": ["auth.log", "pam-agent.log", "syslog"],
};

function resolvePath(cwd: string, arg: string): string {
  if (!arg) return cwd;
  if (arg.startsWith("/")) return arg.replace(/\/+$/, "") || "/";
  const parts = (cwd === "/" ? [] : cwd.split("/")).concat(arg.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.join("/");
}

export function prompt(ctx: ShellContext): string {
  const short = ctx.cwd === `/home/${ctx.user}` ? "~" : ctx.cwd;
  return `\x1b[36m${ctx.user}@${ctx.hostname}\x1b[0m:\x1b[34m${short}\x1b[0m$ `;
}

export function respond(ctx: ShellContext, line: string): string {
  const [cmd, ...args] = line.trim().split(/\s+/);
  switch (cmd) {
    case "":
      return "";
    case "help":
      return [
        "Built-ins: ls, cd, pwd, whoami, hostname, uptime, date, uname, id,",
        "             ps, free, df, clear, exit",
      ].join("\n");
    case "ls": {
      const dir = resolvePath(ctx.cwd, args[0] ?? "");
      const entries = FS[dir];
      if (!entries) return `ls: cannot access '${args[0] ?? dir}': No such file or directory`;
      return entries.map((e) => (e.endsWith("/") ? `\x1b[34m${e}\x1b[0m` : e)).join("  ");
    }
    case "cd": {
      const dir = resolvePath(ctx.cwd, args[0] ?? `/home/${ctx.user}`);
      if (!FS[dir]) return `cd: ${args[0]}: No such file or directory`;
      ctx.cwd = dir;
      return "";
    }
    case "pwd":
      return ctx.cwd;
    case "whoami":
      return ctx.user;
    case "hostname":
      return ctx.hostname;
    case "uptime":
      return ` ${new Date().toTimeString().slice(0, 5)} up 42 days,  load average: 0.24, 0.31, 0.19`;
    case "date":
      return new Date().toUTCString();
    case "uname":
      return args[0] === "-a"
        ? "Linux " + ctx.hostname + " 5.15.0-107-generic #117-Ubuntu SMP x86_64 GNU/Linux"
        : "Linux";
    case "id":
      return `uid=1000(${ctx.user}) gid=1000(${ctx.user}) groups=1000(${ctx.user}),27(sudo)`;
    case "ps":
      return "  PID TTY          TIME CMD\n 1234 pts/0    00:00:00 bash\n 1249 pts/0    00:00:00 ps";
    case "free":
      return "               total        used        free      shared  buff/cache   available\nMem:        16384        6121        8712         214        1550        9810\nSwap:        20479           0       20479";
    case "df":
      return "Filesystem      1K-blocks      Used Available Use% Mounted on\n/dev/sda1       103080888  41225588  56596884  43% /";
    case "exit":
      return "\x1b[2mconnection closed\x1b[0m";
    default:
      return `${cmd}: command not found`;
  }
}

export function connectSequence(ctx: ShellContext): string[] {
  return [
    "\x1b[2m Authenticating against vault…\x1b[0m",
    "\x1b[2m Credential checked out (ttl 900s)\x1b[0m",
    "\x1b[2m Channel encrypted — session recording active\x1b[0m",
    "",
    `Linux ${ctx.hostname} 5.15.0-107-generic x86_64`,
    "",
    "Last login: " + new Date().toUTCString() + " from 10.0.9.14",
    "",
  ];
}
