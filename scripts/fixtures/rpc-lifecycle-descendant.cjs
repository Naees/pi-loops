const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const pidFile = process.env.PI_LOOPS_SPIKE_PID_FILE;
if (!pidFile) throw new Error("PI_LOOPS_SPIKE_PID_FILE is required");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (!child.pid) throw new Error("Lifecycle descendant has no PID");
writeFileSync(pidFile, JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
setInterval(() => {}, 1000);
