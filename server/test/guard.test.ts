/** 安全兜底：只拦毁灭性命令，普通删除/构建目录不受影响。 */
import { describe, expect, it } from "vitest";
import { dangerousCommand } from "../src/guard.js";

const bash = (command: string) => dangerousCommand("bash", { command });
const powershell = (command: string) => dangerousCommand("powershell", { command });

describe("StellaGuard 命令拦截", () => {
	it("拦截毁灭性命令", () => {
		for (const command of [
			"rm -rf /",
			"rm -rf /*",
			"rm -fr ~",
			"rm -rf $HOME",
			"mkfs.ext4 /dev/sda1",
			"dd if=/dev/zero of=/dev/sda",
			":(){ :|:& };:",
			"shutdown -h now",
			"chmod -R 777 /",
		]) {
			expect(bash(command), command).toBeDefined();
		}
		for (const command of ["del /f /s /q C:\\", "rd /s /q C:\\", "format D:", "diskpart"]) {
			expect(powershell(command), command).toBeDefined();
			expect(bash(command), command).toBeDefined();
		}
	});

	it("不拦普通删除与查看", () => {
		for (const command of [
			"rm -rf ./dist",
			"rm -rf node_modules",
			"rm -f /tmp/build.log",
			"ls -la /",
			"echo shutdown",
			"git clean -fd ./build",
		]) {
			expect(bash(command), command).toBeUndefined();
		}
	});

	it("只检查 shell 工具", () => {
		expect(dangerousCommand("read", { path: "/etc/passwd" })).toBeUndefined();
	});
});
