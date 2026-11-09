/**
 * 模型切换 + 收藏冒烟测试（票 05）：faux provider + MemoryStorage，零网络零 key。
 *
 * 覆盖：
 * 1. 模型列表端点：只含已装 provider 的模型（faux 模式两模型；discoverProviders 纯函数级
 *    验证未配 key 的 provider 不出现）；返回默认模型；带会话查询时当前会话模型带 selected 标记。
 * 2. 切换模型：PUT /api/conversations/:id/model 经 configure({ model }) 写入 pi.agent，
 *    GET settings 反映新值、列表 selected 随之移动；下一条回答条目的模型元数据
 *    （model[0].provider / model[0].model）记录新模型——即切换对生成立即生效。
 * 3. 新会话回落默认模型（创建会话时服务端写入 STELLA_DEFAULT_MODEL 解析结果）。
 * 4. 切换校验：未装 provider、不存在 modelId、非法请求体均 400 并给中文提示，原值不变。
 * 5. 默认模型回落（providers.ts）：配置的 provider 未装 → 回落第一个已装 provider 的
 *    第一个模型；modelId 不在目录 → 回落该 provider 第一个模型；两者都记 fallbackFrom。
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { buildModelCatalog, discoverProviders, resolveDefaultModel } from "../src/providers.js";
import { createStella, type Stella } from "../src/stella.js";

interface ModelRefPayload {
	readonly provider: string;
	readonly modelId: string;
}

/** GET /api/models 的条目；带会话查询时当前会话选中的模型带 selected。 */
interface ModelInfo extends ModelRefPayload {
	readonly providerName: string;
	readonly name: string;
	readonly selected?: boolean;
}

interface ModelsResponse {
	readonly models: readonly ModelInfo[];
	readonly defaultModel: ModelRefPayload;
	readonly defaultModelFallback?: { readonly from: string; readonly to: ModelRefPayload };
}

interface SettingsResponse {
	readonly cwd: string;
	readonly custom: boolean;
	readonly model: ModelRefPayload | null;
}

/** 回答条目的消息（pi.assistant 的 model[0]）：携带模型元数据 provider/model。 */
interface AssistantMessagePayload {
	readonly role: string;
	readonly provider?: string;
	readonly model?: string;
	readonly content?: unknown;
}

interface SseEntry {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly AssistantMessagePayload[];
}

interface SseView {
	readonly conversation: { readonly id: number };
	readonly entries: readonly SseEntry[];
}

interface SseEvent {
	readonly event: string;
	readonly data: string;
}

/** faux 模式的两个模型：默认 faux-1，切换目标 faux-2（模型切换测试需要目录里有多个模型）。 */
const FAUX_MODELS = [
	{ id: "faux-1", name: "Faux One" },
	{ id: "faux-2", name: "Faux Two" },
];
const ANSWER = "模型切换测试的回答。";

describe("模型列表 + 切换 + 默认模型回落", () => {
	let stella: Stella;
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "stella-models-"));
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: dataDir });
		stella = await createStella(config, {}, { fauxModels: FAUX_MODELS });
		stella.faux?.setResponses([fauxAssistantMessage(ANSWER)]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	async function newConversation(app: ReturnType<typeof createApp>): Promise<number> {
		const created = await app.request("/api/conversations", { method: "POST" });
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: number };
		return id;
	}

	async function getModels(app: ReturnType<typeof createApp>, conversationId?: number): Promise<ModelsResponse> {
		const query = conversationId === undefined ? "" : `?conversationId=${conversationId}`;
		const response = await app.request(`/api/models${query}`);
		expect(response.status).toBe(200);
		return (await response.json()) as ModelsResponse;
	}

	async function getSettings(app: ReturnType<typeof createApp>, id: number): Promise<SettingsResponse> {
		const response = await app.request(`/api/conversations/${id}/settings`);
		expect(response.status).toBe(200);
		return (await response.json()) as SettingsResponse;
	}

	async function putModel(
		app: ReturnType<typeof createApp>,
		id: number,
		body: unknown,
	): Promise<Response> {
		return app.request(`/api/conversations/${id}/model`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
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

	it("模型列表：只含已装 provider 的模型，含元数据与默认模型，selected 标记当前会话模型", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);

		const catalog = await getModels(app, id);
		// 只含已装 provider（faux 模式只有 faux），两个 faux 模型都在，元数据完整
		expect(catalog.models.map((m) => m.provider)).toEqual(["faux", "faux"]);
		expect(catalog.models.map((m) => m.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(catalog.models[0]).toMatchObject({ providerName: "faux", name: "Faux One" });
		// 新会话创建时服务端写入默认模型：selected 标记与 settings 一致
		expect(catalog.defaultModel).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(catalog.models.find((m) => m.selected)).toMatchObject({ modelId: "faux-1" });
		const settings = await getSettings(app, id);
		expect(settings.model).toEqual({ provider: "faux", modelId: "faux-1" });

		// 不带会话查询：无 selected 标记
		const plain = await getModels(app);
		expect(plain.models.every((m) => m.selected === undefined)).toBe(true);
	});

	it("纯函数级：discoverProviders 只装配了 key 的 provider，目录随之只含它", () => {
		const models = createModels();
		const registered = discoverProviders(models, { DEEPSEEK_API_KEY: "test-key" });
		expect(registered).toEqual(["deepseek"]);
		const catalog = buildModelCatalog(models, registered);
		expect(catalog.length).toBeGreaterThan(0);
		expect(catalog.every((entry) => entry.provider === "deepseek")).toBe(true);
		expect(catalog[0]).toMatchObject({ providerName: "DeepSeek" });
	});

	it("切换模型：configure 生效（settings 与 selected 更新，下一条回答条目记录新模型）", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);

		const put = await putModel(app, id, { provider: "faux", modelId: "faux-2" });
		expect(put.status).toBe(200);
		expect(((await put.json()) as { model: ModelRefPayload | null }).model).toEqual({
			provider: "faux",
			modelId: "faux-2",
		});

		// 会话设置与列表 selected 都反映新模型
		expect((await getSettings(app, id)).model).toEqual({ provider: "faux", modelId: "faux-2" });
		const catalog = await getModels(app, id);
		expect(catalog.models.find((m) => m.selected)).toMatchObject({ modelId: "faux-2" });

		// 下一条回答用新模型：回答条目的模型元数据记录 faux-2（configure 写入 pi.agent，
		// pi-durable 在下一次生成 prepare 时读取——立即生效）
		const posted = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "换个模型回答我" }),
		});
		expect(posted.status).toBe(202);
		const events = await readSse(await app.request(`/api/conversations/${id}/events`));
		const withAnswer = await waitForView(events, (view) =>
			view.entries.some((entry) => entry.kind === "pi.assistant"),
		);
		const answer = withAnswer.entries.find((entry) => entry.kind === "pi.assistant");
		expect(answer?.model?.[0]?.provider).toBe("faux");
		expect(answer?.model?.[0]?.model).toBe("faux-2");

		// 新会话回落默认模型（faux-1），不受上一个会话切换影响
		const secondId = await newConversation(app);
		expect((await getSettings(app, secondId)).model).toEqual({ provider: "faux", modelId: "faux-1" });
	});

	it("切换校验：未装 provider / 不存在的 modelId / 非法请求体均 400，原模型不变", async () => {
		const app = createApp(stella);
		const id = await newConversation(app);

		const unknownProvider = await putModel(app, id, { provider: "anthropic", modelId: "claude-x" });
		expect(unknownProvider.status).toBe(400);
		expect(((await unknownProvider.json()) as { error: string }).error).toContain("未启用");

		const unknownModel = await putModel(app, id, { provider: "faux", modelId: "faux-999" });
		expect(unknownModel.status).toBe(400);
		expect(((await unknownModel.json()) as { error: string }).error).toContain("不在");

		const badBody = await putModel(app, id, { modelId: "缺少 provider" });
		expect(badBody.status).toBe(400);

		expect((await getSettings(app, id)).model).toEqual({ provider: "faux", modelId: "faux-1" });
	});

	it("默认模型回落：provider 未装回落第一个已装 provider，modelId 缺目录回落该 provider 第一个模型", () => {
		const models = createModels();
		const registered = discoverProviders(models, { DEEPSEEK_API_KEY: "test-key" });

		// 配置的 provider 未装（没配 ANTHROPIC_API_KEY）→ 回落 deepseek 目录第一个模型并记 fallbackFrom
		const providerFallback = resolveDefaultModel(models, { provider: "anthropic", modelId: "claude-x" }, registered);
		expect(providerFallback.provider).toBe("deepseek");
		expect(providerFallback.fallbackFrom).toBe("anthropic/claude-x");
		const deepseekCatalog = models.getModels("deepseek");
		expect(deepseekCatalog.some((m) => m.id === providerFallback.modelId)).toBe(true);

		// provider 已装但 modelId 不在目录 → 回落该 provider 第一个模型
		const modelFallback = resolveDefaultModel(models, { provider: "deepseek", modelId: "no-such" }, registered);
		expect(modelFallback.modelId).toBe(deepseekCatalog[0]!.id);
		expect(modelFallback.fallbackFrom).toBe("deepseek/no-such");

		// 完全匹配 → 原样使用，无回落
		const exact = resolveDefaultModel(
			models,
			{ provider: "deepseek", modelId: deepseekCatalog[0]!.id },
			registered,
		);
		expect(exact.fallbackFrom).toBeUndefined();

		// 没有任何已装 provider → 报错（faux 模式固定 faux/faux-1，不会走到这里）
		expect(() =>
			resolveDefaultModel(models, { provider: "deepseek", modelId: "x" }, []),
		).toThrow(/没有任何已装 provider/);
	});
});
