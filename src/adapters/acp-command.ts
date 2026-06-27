import { existsSync } from "node:fs";
import path from "node:path";

export function selectAcpCommand(options: {
  overrideEnv: string;
  globalCommand: string;
  packageName: string;
}): { executable: string; args: string[] } {
  const override = process.env[options.overrideEnv];
  if (override) return { executable: override, args: [] };
  if (findOnPath(options.globalCommand)) return { executable: options.globalCommand, args: [] };
  return { executable: "npx", args: ["-y", options.packageName] };
}

function findOnPath(command: string): boolean {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" && !path.extname(command)
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return directories.some((directory) =>
    extensions.some((extension) => existsSync(path.join(directory, `${command}${extension}`))),
  );
}
