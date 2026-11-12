/**
 * 技能管理：按预设勾选 `data/skills/` 下的技能。
 *
 * 开关写回 `data/stella.config.json` 的预设 `skills` 名单，只影响**之后新建**的会话：
 * 已有会话在创建时已把技能清单定格（保住模型侧的前缀缓存，见 snapshot.ts）。
 *
 * 全选时写 `null`（“跟随全部”），以后往目录里新增的技能才会自动启用；否则名单一旦
 * 冻结成当前这几个，新技能默认就是关的。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchSkills, updatePresetSkills, type PresetSummary, type SkillSummary } from "../api";
import { store } from "../store/app-store";

interface SkillsPanelProps {
	readonly presets: readonly PresetSummary[];
	readonly initialPreset: string | null;
	readonly onClose: () => void;
}

interface SkillDiagnosticView {
	readonly message: string;
	readonly path: string;
}

export function SkillsPanel({ presets, initialPreset, onClose }: SkillsPanelProps): ReactNode {
	const [presetId, setPresetId] = useState<string>(initialPreset ?? presets[0]?.id ?? "standard");
	const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
	const [diagnostics, setDiagnostics] = useState<readonly SkillDiagnosticView[]>([]);
	const [dir, setDir] = useState("");
	const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set());
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const restoreRef = useRef<HTMLElement | null>(null);
	// Shell 每次重渲染都会传新的 onClose；effect 依赖它会把焦点抢回取消按钮。
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// 打开时读一次目录；面板开着期间不跟随目录变化（与“会话创建时定格”一致）。
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const response = await fetchSkills();
				if (!live) return;
				setSkills(response.skills);
				setDiagnostics(response.diagnostics);
				setDir(response.dir);
			} catch (caught) {
				if (live) setError(caught instanceof Error ? caught.message : String(caught));
			} finally {
				if (live) setLoading(false);
			}
		})();
		return () => {
			live = false;
		};
	}, []);

	// 预设或技能列表变化时，按预设名单重置勾选（null = 全部）。
	useEffect(() => {
		const preset = presets.find((item) => item.id === presetId);
		const names = preset?.skills ?? null;
		setEnabled(new Set(names === null ? skills.map((skill) => skill.name) : names));
	}, [presetId, presets, skills]);

	// Esc 关闭；关闭后焦点回到打开它的按钮。
	useEffect(() => {
		restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		cancelRef.current?.focus();
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			restoreRef.current?.focus();
		};
	}, []);

	const toggle = (name: string): void => {
		setEnabled((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	};

	// 预设名单里当前目录扫描不到的名字：面板渲染不出来，但保存时要原样保留。
	const configured = presets.find((item) => item.id === presetId)?.skills ?? [];
	const missing = configured.filter((name) => !skills.some((skill) => skill.name === name));

	const save = async (): Promise<void> => {
		// 空目录/加载失败时无法表达「全选」：不能把 [] 误写成 null（全部）。
		if (skills.length === 0) return;
		setSaving(true);
		setError(undefined);
		try {
			const known = skills.map((skill) => skill.name);
			const selected = known.filter((name) => enabled.has(name));
			const next = [...selected, ...missing];
			await updatePresetSkills(presetId, next.length === known.length + missing.length ? null : next);
			await store.loadPresets();
			onClose();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="modal-root">
			<div className="modal-mask" onClick={onClose} />
			<div className="modal-dialog skills-dialog" role="dialog" aria-modal="true" aria-labelledby="skills-title">
				<div className="modal-header">
					<h3 id="skills-title" className="modal-title">
						技能
					</h3>
				</div>
				<div className="skills-body">
					<div className="skills-preset-row">
						<label className="skills-preset-label" htmlFor="skills-preset">
							预设
						</label>
						<select
							id="skills-preset"
							className="select"
							value={presetId}
							onChange={(event) => setPresetId(event.target.value)}
						>
							{presets.map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.name}
								</option>
							))}
						</select>
						<span className="skills-note">只影响之后新建的会话</span>
					</div>

					{loading ? (
						<p className="skills-empty">正在读取技能目录…</p>
					) : skills.length === 0 ? (
						<p className="skills-empty">
							还没有技能。在 <code>{dir}</code> 下放一个 <code>名字/SKILL.md</code>，开头写 name 与 description。
						</p>
					) : (
						<ul className="skills-list">
							{skills.map((skill) => (
								<li key={skill.name}>
									<label className="skill-row">
										<input
											type="checkbox"
											checked={enabled.has(skill.name)}
											onChange={() => toggle(skill.name)}
										/>
										<span className="skill-text">
											<span className="skill-name">
												{skill.name}
												{skill.disableModelInvocation && <span className="skill-badge">仅手动</span>}
											</span>
											<span className="skill-desc">{skill.description}</span>
										</span>
									</label>
								</li>
							))}
						</ul>
					)}

					{missing.length > 0 && (
						<p className="skills-note">{`配置里还有目录中找不到的技能，保存时原样保留：${missing.join("、")}`}</p>
					)}
					{diagnostics.length > 0 && (
						<div className="skills-diagnostics">
							{diagnostics.map((item, index) => (
								<p key={`${item.path}-${index}`}>{`${item.path}：${item.message}`}</p>
							))}
						</div>
					)}
					{error !== undefined && <p className="skills-error">{error}</p>}
				</div>
				<div className="modal-footer">
					<button ref={cancelRef} className="btn btn-md btn-ghost" type="button" onClick={onClose}>
						取消
					</button>
					<button
						className="btn btn-md btn-primary"
						type="button"
						disabled={saving || loading || error !== undefined || skills.length === 0}
						onClick={() => void save()}
					>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
			</div>
		</div>
	);
}
