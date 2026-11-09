/**
 * 工作目录 + 工具调用展示冒烟测试（票 04）：faux provider + MemoryStorage，零网络零 key。
 *
 * 覆盖：
 * 1. 工作目录查看：GET settings 默认为服务端配置的默认工作区（STELLA_DATA_DIR 下的 workspace）。
 * 2. 工作目录修改：PUT 新目录后 GET 反映新值；后续工具调用（faux 脚本发起 write）立即落在
 *    新目录——configure() 写入 pi.agent，env 回调按当前 cwd 构建执行环境，立即生效。
 * 3. 校验：不存在目录、相对路径、文件路径均被 400 拒绝并给中文提示，原值不变。
 * 4. 恢复默认：PUT { cwd: null } 清除显式设置，回到默认工作区。
 * 5. 工具调用展示契约：faux 模型发起 write+bash 调用时，SSE view 里 assistant 条目携带
 *    toolCall 块（name/arguments）、pi.tool-result 条目携带结果字段（toolCallId/toolName/
 *    isError/content 输出），运行期间 pi.live.tools 槽位可见（status 非 done）。
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { createStella, type Stella } from "../src/stella.js";

interface ContentBlock {
	readonly type: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: Record<string, unknown>;
}

interface ModelMessage {
	readonly role: string;
	readonly content: string | readonly ContentBlock[];
}

interface ToolResultMessage {
	readonly role: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly isError?: boolean;
}

interface SseEntry {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly ModelMessage[];
}

interface LiveToolSlot {
	readonly callId?: string;
	readonly name?: string;
	readonly status?: string;
	readonly output?: string;
}

interface LiveDoc {
	readonly run?: { readonly first?: number } | null;
	readonly tools?: readonly LiveToolSlot[] | null;
	readonly runFailure?: { readonly reason?: string } | null;
}

interface SseView {
	readonly conversation: { readonly id: number };
	readonly entries: readonly SseEntry[];
	readonly docs: Record<string, LiveDoc>;
}

interface WorkspaceSettings {
	readonly cwd: string;
	readonly defaultWorkspace: string;
	readonly custom: boolean;
}

interface SseEvent {
	readonly event: string;
	readonly data: string;
}

/** 窄化：条目 model[0] 是工具结果消息（pi.tool-result）。 */
function isToolResultMessage(message: ModelMessage | undefined): message is ModelMessage & ToolResultMessage {
	return message?.role === "toolResult";
}

describe("工作目录 + 工具调用展示", () => {
	let stella: Stella;
	let dataDir: string;
	let workspaceDir: string;
	let otherDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "stella-data-"));
		otherDir = await mkdtemp(join(tmpdir(), "stella-other-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: dataDir });
		stella = await createStella(config, {});
		workspaceDir = config.workspaceDir;
	});

	afterEach(async () => {
		await stella.close();
		await rm(dataDir, { recursive: true, force: true });
		await rm(otherDir, { recursive: true, force: true });
	});

	async function newConversation(app: ReturnType<typeof createApp>): Promise<number> {
		const created = await app.request("/api/conversations", { method: "POST" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: number };
		return id;
	}

	async function readSse(response: Response): Promise<SseEvent[]> {
		const events: SseEvent[] = [];
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const parseChunk = (chunk: string): void => {
			buffer += chunk;
			for (;;) {
				const boundary = buffer.indexOf("\n\n");
				if (boundary < 0) break;
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = /^event: (.*)$/m.exec(raw)?.[1] ?? "message";
				const data = /^data: (.*)$/m.exec(raw)?.[1] ?? "";
				events.push({ event, data });
			}
		};
		void (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				parseChunk(decoder.decode(value, { stream: true }));
			}
		})();
		return events;
	}

	async function waitForView(
		events: readonly SseEvent[],
		predicate: (view: SseView) => boolean,
	): Promise<SseView> {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const hit = events
				.filter((e) => e.event === "view")
				.map((e) => JSON.parse(e.data) as SseView)
				.find(predicate);
			if (hit !== undefined) return hit;
			if (Date.now() > deadline) throw new Error("等待 SSE view 超时");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	async function getSettings(app: ReturnType<typeof createApp>, id: number): Promise<WorkspaceSettings> {
		const response = await app.request(`/api/conversations/${id}/settings`);
		expect(response.status).toBe(200);
		return (await response.json()) as WorkspaceSettings;
	}

	/** 订阅 SSE、提交一条消息，返回事件数组。 */
	async function subscribeAndSend(
		app: ReturnType<typeof createApp>,
		id: number,
		content = "建个文件",
	): Promise<SseEvent[]> {
		const events = readSse(await app.request(`/api/conversations/${id}/events`));
		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content }),
		});
		expect(posted.status).toBe(202);
		return events;
	}

	it("查看：GET 默认返回默认工作区，custom 为假", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);
		const settings = await getSettings(app, id);
		expect(settings.cwd).toBe(workspaceDir);
		expect(settings.defaultWorkspace).toBe(workspaceDir);
		expect(settings.custom).toBe(false);
	});

	it("修改：PUT 新目录后 GET 反映新值，后续工具调用立即落在新目录", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);

		const put = await app.request(`/api/conversations/${id}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: otherDir }),
		});
		expect(put.status).toBe(200);
		const updated = (await put.json()) as WorkspaceSettings;
		expect(updated.cwd).toBe(otherDir);
		expect(updated.custom).toBe(true);

		const settings = await getSettings(app, id);
		expect(settings.cwd).toBe(otherDir);
		expect(settings.custom).toBe(true);

		// 立即生效：faux 模型发起 write 相对路径，文件应落在新目录而非默认工作区
		const target = join(otherDir, "moved.txt");
		stella.faux?.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "moved.txt", content: "新目录" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已在新目录创建文件。"),
		]);
		await waitForView(await subscribeAndSend(app, id), (view) =>
			view.entries.some((entry) => entry.kind === "pi.tool-result"),
		);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(workspaceDir, "moved.txt"))).toBe(false);
	});

	it("校验：不存在目录 / 相对路径 / 文件路径均 400 并给中文提示，原值不变", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);

		const missing = await app.request(`/api/conversations/${id}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: join(tmpdir(), "stella-no-such-dir-不存在的目录") }),
		});
		expect(missing.status).toBe(400);
		expect(((await missing.json()) as { error: string }).error).toContain("目录不存在");

		const relativePath = await app.request(`/api/conversations/${id}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: "relative/path" }),
		});
		expect(relativePath.status).toBe(400);
		expect(((await relativePath.json()) as { error: string }).error).toContain("绝对路径");

		const filePath = join(otherDir, "plain.txt");
		writeFileSync(filePath, "不是目录");
		const filePut = await app.request(`/api/conversations/${id}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: filePath }),
		});
		expect(filePut.status).toBe(400);
		expect(((await filePut.json()) as { error: string }).error).toContain("不是目录");

		const settings = await getSettings(app, id);
		expect(settings.cwd).toBe(workspaceDir); // 校验失败的 PUT 不改变当前值
		expect(settings.custom).toBe(false);
	});

	it("恢复默认：PUT cwd=null 清除显式设置，回到默认工作区", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);
		await app.request(`/api/conversations/${id}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: otherDir }),
		});

		const reset = await app.request(`/api/conversations/${id}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: null }),
		});
		expect(reset.status).toBe(200);
		const settings = (await reset.json()) as WorkspaceSettings;
		expect(settings.cwd).toBe(workspaceDir);
		expect(settings.custom).toBe(false);
	});

	it("工具调用 SSE 契约：toolCall 块、tool-result 条目、pi.live.tools 槽位字段完整", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);

		// 脚本：先发起 write + bash 两个工具调用（bash 睡 800ms 以便抓到运行中槽位），再给最终回答
		stella.faux?.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("write", { path: "hello.txt", content: "你好，工作目录" }),
					fauxToolCall("bash", { command: "node -e 'setTimeout(function(){},800)'" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("文件已创建，命令已运行。"),
		]);

		const events = await subscribeAndSend(app, id);

		// 运行中槽位可见：pi.live.tools 里有 bash 槽位且 status 非 done
		const withRunning = await waitForView(events, (view) =>
			(view.docs["pi.live"]?.tools ?? []).some((slot) => slot.name === "bash" && slot.status !== "done"),
		);
		const running = withRunning.docs["pi.live"]?.tools?.find((slot) => slot.name === "bash");
		expect(running?.callId).toBeTruthy();

		// 调用条目：assistant 条目携带 toolCall 块（name 与 arguments 完整）
		const withCalls = await waitForView(events, (view) =>
			view.entries.some(
				(entry) =>
					entry.kind === "pi.assistant" &&
					Array.isArray(entry.model?.[0]?.content) &&
					(entry.model?.[0]?.content as readonly ContentBlock[]).some((block) => block.type === "toolCall"),
			),
		);
		const callEntry = withCalls.entries.find((entry) => entry.kind === "pi.assistant");
		const blocks = (callEntry?.model?.[0]?.content ?? []) as readonly ContentBlock[];
		const write = blocks.find((block) => block.type === "toolCall" && block.name === "write");
		const bash = blocks.find((block) => block.type === "toolCall" && block.name === "bash");
		expect(write?.id).toBeTruthy();
		expect(write?.arguments).toMatchObject({ path: "hello.txt" });
		expect(bash?.id).toBeTruthy();
		expect(String(bash?.arguments?.command)).toContain("setTimeout");

		// 结果条目：pi.tool-result 与调用按 toolCallId 关联，isError 为假、输出文本非空
		const withResults = await waitForView(events, (view) => {
			const results = view.entries.filter((entry) => entry.kind === "pi.tool-result");
			return results.length >= 2;
		});
		const resultEntries = withResults.entries.filter((entry) => entry.kind === "pi.tool-result");
		const byCallId = new Map<string, ToolResultMessage>();
		for (const entry of resultEntries) {
			const message = entry.model?.[0];
			if (isToolResultMessage(message) && typeof message.toolCallId === "string") {
				byCallId.set(message.toolCallId, message);
			}
		}
		const writeResult = byCallId.get(write!.id!);
		const bashResult = byCallId.get(bash!.id!);
		expect(writeResult).toBeDefined();
		expect(writeResult?.toolName).toBe("write");
		expect(writeResult?.isError).toBe(false);
		expect((writeResult?.content ?? []).some((block) => (block.text ?? "").includes("hello.txt"))).toBe(true);
		expect(bashResult).toBeDefined();
		expect(bashResult?.toolName).toBe("bash");
		expect(bashResult?.isError).toBe(false);

		// 运行结束：最终回答落定，运行态槽位清空
		const ended = await waitForView(events, (view) =>
			view.entries.some((entry) => {
				if (entry.kind !== "pi.assistant") return false;
				const blocks = entry.model?.[0]?.content;
				return (
					Array.isArray(blocks) &&
					blocks.some((block) => block.type === "text" && (block.text ?? "").includes("命令已运行"))
				);
			}),
		);
		expect(ended.docs["pi.live"]?.tools ?? []).toEqual([]);
		expect(ended.docs["pi.live"]?.run ?? null).toBeNull();

		// 文件真的落在工作目录（write 工具以会话 cwd 执行）
		expect(existsSync(join(workspaceDir, "hello.txt"))).toBe(true);
	});

	it("不存在的目录经 configure 直接拒绝由 API 层完成；服务端 data/workspace 缺失时恢复默认仍可用", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);
		// 模拟用户手动删掉了默认工作区：恢复默认后 write 相对路径仍应成功（NodeExecutionEnv 不预建目录，
		// write 工具对不存在的父目录会失败——这里只保证恢复默认 API 成功且 GET 指回默认工作区）
		await rm(workspaceDir, { recursive: true, force: true });
		const reset = await app.request(`/api/conversations/${id}/settings`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: null }),
		});
		expect(reset.status).toBe(200);
		const settings = (await reset.json()) as WorkspaceSettings;
		expect(settings.cwd).toBe(workspaceDir);
		// 重新创建目录后工具可写
		mkdirSync(workspaceDir, { recursive: true });
		stella.faux?.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "back.txt", content: "回来了" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("好了。"),
		]);
		await waitForView(await subscribeAndSend(app, id), (view) =>
			view.entries.some((entry) => entry.kind === "pi.tool-result"),
		);
		expect(existsSync(join(workspaceDir, "back.txt"))).toBe(true);
	});
});
