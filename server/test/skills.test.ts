/**
 * 技能：扫描 SKILL.md、渲染系统提示里的索引、按预设白名单定格进会话快照。
 *
 * 关键契约：
 * - 目录里只有 `SKILL.md` 才算技能；`description` 必需；重名先到先得。
 * - 系统提示只放名字/描述/路径，正文由 read 按需读取。
 * - 创建会话时把索引定格；之后目录增删只影响新会话（保住模型侧前缀缓存）。
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createApp, expandSkillMessage } from "../src/api.js";
import { ConversationMeta } from "../src/conversations.js";
import { loadConfig } from "../src/config.js";
import {
	parseFrontmatter,
	renderSkillsCatalog,
	scanSkills,
	SkillSnapshot,
} from "../src/extensions/skills/index.js";
import { createStella, type Stella } from "../src/stella.js";

async function writeSkill(
	root: string,
	directory: string,
	frontmatter: string,
	body = "# 正文\n",
): Promise<void> {
	const dir = join(root, directory);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`, "utf8");
}

describe("技能扫描与渲染", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "stella-skills-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("parseFrontmatter 只读顶层 key: value，支持引号", () => {
		expect(parseFrontmatter("---\nname: demo\ndescription: \"带引号\"\n---\n正文")).toEqual({
			name: "demo",
			description: "带引号",
		});
		expect(parseFrontmatter("没有 frontmatter")).toBeUndefined();
		expect(parseFrontmatter("---\nname: demo\n没有结束线")).toBeUndefined();
	});

	it("扫描目录：description 必需、name 缺省目录名、坏文件跳过", async () => {
		await writeSkill(dir, "alpha", "name: alpha\ndescription: 第一个技能");
		await writeSkill(dir, "beta", "description: 没写名字");
		await writeSkill(dir, "broken", "name: broken");
		await writeFile(join(dir, "broken", "SKILL.md"), "没有 frontmatter", "utf8");

		const scan = scanSkills(dir);
		expect(scan.skills.map((skill) => skill.name).sort()).toEqual(["alpha", "beta"]);
		expect(scan.skills.find((skill) => skill.name === "beta")?.description).toBe("没写名字");
		expect(scan.diagnostics.length).toBeGreaterThan(0);
	});

	it("frontmatter 支持块标量与行尾注释", () => {
		const folded = parseFrontmatter(`---
name: demo
description: >-
  第一行
  第二行
disable-model-invocation: true # 手动触发
---
正文`);
		expect(folded?.description).toBe("第一行 第二行");
		expect(folded?.["disable-model-invocation"]).toBe("true");

		const literal = parseFrontmatter(`---
description: |
  第一行
  第二行
---
`);
		expect(literal?.description).toBe("第一行\n第二行");
	});

	it("重名先到先得；disable-model-invocation 的技能保留在结果里", async () => {
		await writeSkill(dir, "a-first", "name: same\ndescription: 先到");
		await writeSkill(dir, "b-second", "name: same\ndescription: 后到");
		await writeSkill(dir, "hidden", "name: hidden\ndescription: 只能手动\ndisable-model-invocation: true");

		const scan = scanSkills(dir);
		expect(scan.skills.find((skill) => skill.name === "same")?.description).toBe("先到");
		expect(scan.skills.find((skill) => skill.name === "hidden")?.disableModelInvocation).toBe(true);
	});

	it("渲染索引：只放名字/描述/路径，转义 XML，隐藏技能不进提示", async () => {
		await writeSkill(dir, "alpha", "name: alpha\ndescription: 用 <与> & 的说明");
		await writeSkill(dir, "hidden", "name: hidden\ndescription: 不该出现\ndisable-model-invocation: true");
		const catalog = renderSkillsCatalog(scanSkills(dir).skills);

		expect(catalog).toContain("<available_skills>");
		expect(catalog).toContain("<name>alpha</name>");
		expect(catalog).toContain("用 &lt;与&gt; &amp; 的说明");
		expect(catalog).toContain(join(dir, "alpha", "SKILL.md"));
		expect(catalog).not.toContain("hidden");
		expect(renderSkillsCatalog([])).toBe("");
	});
});

describe("技能与预设、会话快照", () => {
	let stella: Stella;
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "stella-test-"));
		await writeSkill(join(dataDir, "skills"), "alpha", "name: alpha\ndescription: 阿尔法");
		await writeSkill(join(dataDir, "skills"), "beta", "name: beta\ndescription: 贝塔");
		const config = loadConfig({ STELLA_FAUX: "1", STELLA_DATA_DIR: dataDir });
		stella = await createStella(config, {});
		stella.faux?.setResponses([fauxAssistantMessage("收到。")]);
	});

	afterEach(async () => {
		await stella.close();
		await rm(dataDir, { recursive: true, force: true });
	});

	async function createConversation(presetId?: string): Promise<ConversationId> {
		const app = createApp(stella);
		const response = await app.request("/api/conversations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(presetId === undefined ? {} : { preset: presetId }),
		});
		expect(response.status).toBe(201);
		return ((await response.json()) as { id: ConversationId }).id;
	}

	it("GET /api/skills 返回扫描结果与目录", async () => {
		const app = createApp(stella);
		const response = await app.request("/api/skills");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			dir: string;
			skills: { name: string; description: string }[];
			diagnostics: unknown[];
		};
		expect(body.dir).toBe(join(dataDir, "skills"));
		expect(body.skills.map((skill) => skill.name).sort()).toEqual(["alpha", "beta"]);
	});

	it("skills 为 null：创建会话时全部技能进入快照，并自动带上 stella-skills 扩展", async () => {
		const id = await createConversation("standard");
		const snapshot = await stella.harness.snapshot(SkillSnapshot, id, BACKGROUND_CONTEXT);
		expect(snapshot?.catalog).toContain("<name>alpha</name>");
		expect(snapshot?.catalog).toContain("<name>beta</name>");

		const conversation = await stella.harness.conversation(id, BACKGROUND_CONTEXT);
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		expect(agent.extensions.map((extension) => extension.name)).toContain("stella-skills");
	});

	it("预设白名单只放进选中的技能；空数组表示全禁", async () => {
		const app = createApp(stella);
		await writeFile(
			join(dataDir, "stella.config.json"),
			JSON.stringify({
				presets: [
					{ id: "only-alpha", name: "只要 alpha", skills: ["alpha"] },
					{ id: "nothing", name: "没有技能", skills: [] },
				],
			}),
			"utf8",
		);
		expect(stella.settings.reload()).toBe(true);

		const alphaId = await createConversation("only-alpha");
		const alphaSnapshot = await stella.harness.snapshot(SkillSnapshot, alphaId, BACKGROUND_CONTEXT);
		expect(alphaSnapshot?.catalog).toContain("<name>alpha</name>");
		expect(alphaSnapshot?.catalog).not.toContain("<name>beta</name>");

		const noneId = await createConversation("nothing");
		const noneSnapshot = await stella.harness.snapshot(SkillSnapshot, noneId, BACKGROUND_CONTEXT);
		expect(noneSnapshot?.catalog).toBe("");
	});

	it("目录变化只影响新会话：已有会话的快照不变（前缀缓存稳定）", async () => {
		const oldId = await createConversation("standard");
		const before = await stella.harness.snapshot(SkillSnapshot, oldId, BACKGROUND_CONTEXT);

		await writeSkill(join(dataDir, "skills"), "gamma", "name: gamma\ndescription: 伽马");
		stella.skills.reload();
		const newId = await createConversation("standard");

		const oldAfter = await stella.harness.snapshot(SkillSnapshot, oldId, BACKGROUND_CONTEXT);
		const newSnapshot = await stella.harness.snapshot(SkillSnapshot, newId, BACKGROUND_CONTEXT);
		expect(oldAfter?.catalog).toBe(before?.catalog);
		expect(oldAfter?.catalog).not.toContain("gamma");
		expect(newSnapshot?.catalog).toContain("gamma");
	});

	it("隐藏技能可经 /skill 手动加载；文件被删后报「读不到」", async () => {
		await writeSkill(
			join(dataDir, "skills"),
			"hidden",
			"name: hidden\ndescription: 只允许手动\ndisable-model-invocation: true",
		);
		stella.skills.reload();
		const id = await createConversation("standard");

		const snapshot = await stella.harness.snapshot(SkillSnapshot, id, BACKGROUND_CONTEXT);
		expect(snapshot?.catalog).not.toContain("hidden");
		const loaded = await expandSkillMessage(stella, id, "hidden", "做点事");
		if (!("text" in loaded)) throw new Error(`expected text, got ${JSON.stringify(loaded)}`);
		expect(loaded.text).toContain("# 正文");

		await rm(join(dataDir, "skills", "hidden"), { recursive: true, force: true });
		const gone = await expandSkillMessage(stella, id, "hidden", "做点事");
		expect(gone).toEqual({ error: "unreadable" });
	});

	it("extensions 为空数组时，选了技能也会自动带上 stella-skills", async () => {
		const app = createApp(stella);
		await writeFile(
			join(dataDir, "stella.config.json"),
			JSON.stringify({ presets: [{ id: "bare", name: "裸", extensions: [], skills: ["alpha"] }] }),
			"utf8",
		);
		expect(stella.settings.reload()).toBe(true);

		const id = await createConversation("bare");
		const conversation = await stella.harness.conversation(id, BACKGROUND_CONTEXT);
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		expect(agent.extensions.map((extension) => extension.name)).toEqual(["stella-skills"]);
	});

	it("写回只改 skills，保留其他预设、字段与内置预设的完整定义", async () => {
		const configPath = join(dataDir, "stella.config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				defaultMaxTurns: 42,
				settings: { stream: { timeoutMs: 123 } },
				presets: [{ id: "custom", name: "自定义", description: "保留我" }],
			}),
			"utf8",
		);
		expect(stella.settings.reload()).toBe(true);

		const app = createApp(stella);
		const response = await app.request("/api/presets/standard/skills", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ skills: ["alpha"] }),
		});
		expect(response.status).toBe(200);

		const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
			defaultMaxTurns: number;
			settings: { stream: { timeoutMs: number } };
			presets: { id: string; name?: string; description?: string; skills?: string[] | null }[];
		};
		expect(raw.defaultMaxTurns).toBe(42);
		expect(raw.settings.stream.timeoutMs).toBe(123);
		expect(raw.presets.find((preset) => preset.id === "custom")?.description).toBe("保留我");
		const standard = raw.presets.find((preset) => preset.id === "standard");
		expect(standard?.skills).toEqual(["alpha"]);
		expect(standard?.name).toBe("标准");
	});

	it("PUT 拒绝未知技能名与重复名字", async () => {
		const app = createApp(stella);
		const unknown = await app.request("/api/presets/standard/skills", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ skills: ["nope"] }),
		});
		expect(unknown.status).toBe(400);

		const deduped = await app.request("/api/presets/standard/skills", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ skills: ["alpha", "alpha"] }),
		});
		expect(deduped.status).toBe(200);
		expect(stella.settings.preset("standard")?.skills).toEqual(["alpha"]);
	});

	it("PUT /api/presets/:id/skills 写回配置文件，后续会话按新名单解析", async () => {
		const app = createApp(stella);
		const response = await app.request("/api/presets/standard/skills", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ skills: ["beta"] }),
		});
		expect(response.status).toBe(200);
		expect(stella.settings.preset("standard")?.skills).toEqual(["beta"]);

		const id = await createConversation("standard");
		const snapshot = await stella.harness.snapshot(SkillSnapshot, id, BACKGROUND_CONTEXT);
		expect(snapshot?.catalog).toContain("<name>beta</name>");
		expect(snapshot?.catalog).not.toContain("<name>alpha</name>");

		// 停用全部：写 null 表示回到「全部」
		const reset = await app.request("/api/presets/standard/skills", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ skills: null }),
		});
		expect(reset.status).toBe(200);
		expect(stella.settings.preset("standard")?.skills).toBeNull();
	});

	it("/skill <名字> 把正文拼在要求前面；名字不在快照里返回 400", async () => {
		const id = await createConversation("standard");
		const app = createApp(stella);
		const ok = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "照着做", skill: "alpha" }),
		});
		expect(ok.status).toBe(202);
		const expanded = await expandSkillMessage(stella, id, "alpha", "照着做");
		if (!("text" in expanded)) throw new Error(`expected text, got ${JSON.stringify(expanded)}`);
		expect(expanded.text).toContain("# 正文");
		expect(expanded.text).toContain("照着做");
		// 正文里的相对路径要能按 baseDir 解析
		expect(expanded.text).toContain(join(dataDir, "skills", "alpha"));
		// 标题取用户写的要求，不取拼接进来的技能正文。
		const meta = await stella.harness.snapshot(ConversationMeta, id, BACKGROUND_CONTEXT);
		expect(meta?.title).toBe("照着做");

		const missing = await app.request(`/api/conversations/${id}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "照着做", skill: "nope" }),
		});
		expect(missing.status).toBe(400);
		// 等这次运行收尾，避免 afterEach 关闭时打出 "Harness is closed" 噪声。
		await (await stella.harness.conversation(id, BACKGROUND_CONTEXT))?.waitForIdle(BACKGROUND_CONTEXT);
	});

	it("未知预设的技能开关返回 404；非法请求体返回 400", async () => {
		const app = createApp(stella);
		const missing = await app.request("/api/presets/nope/skills", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ skills: [] }),
		});
		expect(missing.status).toBe(404);

		const bad = await app.request("/api/presets/standard/skills", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ skills: "alpha" }),
		});
		expect(bad.status).toBe(400);
	});
});
