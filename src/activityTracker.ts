import * as vscode from 'vscode';

// 编辑会话记录
export interface EditSession {
	startTime: number;
	endTime: number;
	languageId: string;
	fileName: string;
	durationSeconds: number;
}

// 每日编辑统计
export interface DailyEditStats {
	date: string; // YYYY-MM-DD
	totalSeconds: number;
	languageStats: { [key: string]: number }; // 语言 -> 秒数
	sessions: EditSession[];
}

// 语言显示名称映射
const LANGUAGE_DISPLAY_NAMES: { [key: string]: string } = {
	'javascript': 'JavaScript',
	'typescript': 'TypeScript',
	'typescriptreact': 'TypeScript React',
	'javascriptreact': 'JavaScript React',
	'python': 'Python',
	'java': 'Java',
	'csharp': 'C#',
	'cpp': 'C++',
	'c': 'C',
	'go': 'Go',
	'rust': 'Rust',
	'ruby': 'Ruby',
	'php': 'PHP',
	'swift': 'Swift',
	'kotlin': 'Kotlin',
	'html': 'HTML',
	'css': 'CSS',
	'scss': 'SCSS',
	'less': 'LESS',
	'json': 'JSON',
	'yaml': 'YAML',
	'xml': 'XML',
	'markdown': 'Markdown',
	'sql': 'SQL',
	'shellscript': 'Shell',
	'powershell': 'PowerShell',
	'dockerfile': 'Dockerfile',
	'vue': 'Vue',
	'svelte': 'Svelte',
	'plaintext': '纯文本',
};

export function getLanguageDisplayName(languageId: string): string {
	return LANGUAGE_DISPLAY_NAMES[languageId] || languageId;
}

export class ActivityTracker {
	private static instance: ActivityTracker;
	private context: vscode.ExtensionContext;

	// 追踪状态
	private isTracking: boolean = false;
	private currentLanguage: string = '';
	private currentFileName: string = '';
	private sessionStartTime: number = 0;
	private lastActivityTime: number = 0;

	// 配置
	private readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5分钟无活动视为空闲
	private readonly HEARTBEAT_INTERVAL_MS = 30 * 1000; // 30秒心跳检测
	private readonly MIN_SESSION_SECONDS = 10; // 最小会话时长（秒）

	// 定时器
	private heartbeatTimer: NodeJS.Timeout | null = null;

	// 事件
	private _onStatsUpdated = new vscode.EventEmitter<DailyEditStats>();
	public readonly onStatsUpdated = this._onStatsUpdated.event;

	private constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	public static getInstance(context?: vscode.ExtensionContext): ActivityTracker {
		if (!ActivityTracker.instance) {
			if (!context) {
				throw new Error('ActivityTracker 需要 ExtensionContext 进行初始化');
			}
			ActivityTracker.instance = new ActivityTracker(context);
		}
		return ActivityTracker.instance;
	}

	// 初始化追踪器
	public initialize(): vscode.Disposable[] {
		const disposables: vscode.Disposable[] = [];

		// 监听文档变更事件
		disposables.push(
			vscode.workspace.onDidChangeTextDocument(this.onDocumentChange.bind(this))
		);

		// 监听活动编辑器变更
		disposables.push(
			vscode.window.onDidChangeActiveTextEditor(this.onActiveEditorChange.bind(this))
		);

		// 监听窗口焦点变化
		disposables.push(
			vscode.window.onDidChangeWindowState(this.onWindowStateChange.bind(this))
		);

		// 启动心跳检测
		this.startHeartbeat();

		// 如果当前有活动编辑器，开始追踪
		if (vscode.window.activeTextEditor) {
			this.startSession(vscode.window.activeTextEditor.document);
		}

		console.log('ActivityTracker 已初始化');
		return disposables;
	}

	// 文档变更处理
	private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
		if (event.contentChanges.length === 0) {
			return;
		}

		const document = event.document;

		// 忽略非文件 scheme（如 output、debug 等）
		if (document.uri.scheme !== 'file') {
			return;
		}

		this.recordActivity(document);
	}

	// 活动编辑器变更处理
	private onActiveEditorChange(editor: vscode.TextEditor | undefined): void {
		if (editor && editor.document.uri.scheme === 'file') {
			// 结束当前会话，开始新会话
			this.endCurrentSession();
			this.startSession(editor.document);
		} else {
			// 没有活动编辑器，结束当前会话
			this.endCurrentSession();
		}
	}

	// 窗口状态变更处理
	private onWindowStateChange(state: vscode.WindowState): void {
		if (!state.focused) {
			// 窗口失去焦点，结束当前会话
			this.endCurrentSession();
		} else if (vscode.window.activeTextEditor) {
			// 窗口获得焦点，开始新会话
			this.startSession(vscode.window.activeTextEditor.document);
		}
	}

	// 记录活动
	private recordActivity(document: vscode.TextDocument): void {
		const now = Date.now();
		const languageId = document.languageId;
		const fileName = document.fileName;

		// 检查是否需要开始新会话
		if (!this.isTracking) {
			this.startSession(document);
			return;
		}

		// 检查是否切换了语言或文件
		if (languageId !== this.currentLanguage || fileName !== this.currentFileName) {
			this.endCurrentSession();
			this.startSession(document);
			return;
		}

		// 检查是否超过空闲时间
		if (now - this.lastActivityTime > this.IDLE_TIMEOUT_MS) {
			this.endCurrentSession();
			this.startSession(document);
			return;
		}

		// 更新最后活动时间
		this.lastActivityTime = now;
	}

	// 开始新会话
	private startSession(document: vscode.TextDocument): void {
		const now = Date.now();
		this.isTracking = true;
		this.currentLanguage = document.languageId;
		this.currentFileName = document.fileName;
		this.sessionStartTime = now;
		this.lastActivityTime = now;
	}

	// 结束当前会话
	private endCurrentSession(): void {
		if (!this.isTracking) {
			return;
		}

		const now = Date.now();
		// 使用最后活动时间作为结束时间，而不是当前时间
		const endTime = this.lastActivityTime;
		const durationSeconds = Math.floor((endTime - this.sessionStartTime) / 1000);

		// 只记录超过最小时长的会话
		if (durationSeconds >= this.MIN_SESSION_SECONDS) {
			const session: EditSession = {
				startTime: this.sessionStartTime,
				endTime: endTime,
				languageId: this.currentLanguage,
				fileName: this.currentFileName,
				durationSeconds: durationSeconds
			};

			this.saveSession(session);
		}

		this.isTracking = false;
		this.currentLanguage = '';
		this.currentFileName = '';
		this.sessionStartTime = 0;
	}

	// 保存会话到存储
	private saveSession(session: EditSession): void {
		const dateKey = this.getDateKey(session.startTime);
		const stats = this.getDailyStats(dateKey);

		// 更新总时长
		stats.totalSeconds += session.durationSeconds;

		// 更新语言统计
		if (!stats.languageStats[session.languageId]) {
			stats.languageStats[session.languageId] = 0;
		}
		stats.languageStats[session.languageId] += session.durationSeconds;

		// 添加会话记录
		stats.sessions.push(session);

		// 保存到存储
		this.saveDailyStats(dateKey, stats);

		// 触发更新事件
		this._onStatsUpdated.fire(stats);

		console.log(`会话已保存: ${getLanguageDisplayName(session.languageId)} - ${session.durationSeconds}秒`);
	}

	// 获取日期键
	private getDateKey(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toISOString().split('T')[0];
	}

	// 获取每日统计
	public getDailyStats(dateKey: string): DailyEditStats {
		const storageKey = `editStats_${dateKey}`;
		const stored = this.context.globalState.get<DailyEditStats>(storageKey);

		if (stored) {
			return stored;
		}

		return {
			date: dateKey,
			totalSeconds: 0,
			languageStats: {},
			sessions: []
		};
	}

	// 保存每日统计
	private saveDailyStats(dateKey: string, stats: DailyEditStats): void {
		const storageKey = `editStats_${dateKey}`;
		this.context.globalState.update(storageKey, stats);
	}

	// 获取日期范围内的统计
	public getStatsInRange(startDate: string, endDate: string): DailyEditStats[] {
		const results: DailyEditStats[] = [];
		const start = new Date(startDate);
		const end = new Date(endDate);

		for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
			const dateKey = d.toISOString().split('T')[0];
			const stats = this.getDailyStats(dateKey);
			if (stats.totalSeconds > 0) {
				results.push(stats);
			}
		}

		return results;
	}

	// 获取今日统计
	public getTodayStats(): DailyEditStats {
		const today = this.getDateKey(Date.now());
		const stored = this.getDailyStats(today);

		// 创建副本，避免修改原始存储数据
		const stats: DailyEditStats = {
			date: stored.date,
			totalSeconds: stored.totalSeconds,
			languageStats: { ...stored.languageStats },
			sessions: [...stored.sessions]
		};

		// 如果正在追踪，加上当前会话的时间
		if (this.isTracking) {
			const currentDuration = Math.floor((this.lastActivityTime - this.sessionStartTime) / 1000);
			if (currentDuration >= this.MIN_SESSION_SECONDS) {
				stats.totalSeconds += currentDuration;
				if (!stats.languageStats[this.currentLanguage]) {
					stats.languageStats[this.currentLanguage] = 0;
				}
				stats.languageStats[this.currentLanguage] += currentDuration;
			}
		}

		return stats;
	}

	// 获取语言占比
	public getLanguagePercentages(stats: DailyEditStats): { language: string; displayName: string; seconds: number; percentage: number }[] {
		const result: { language: string; displayName: string; seconds: number; percentage: number }[] = [];

		if (stats.totalSeconds === 0) {
			return result;
		}

		for (const [language, seconds] of Object.entries(stats.languageStats)) {
			result.push({
				language,
				displayName: getLanguageDisplayName(language),
				seconds,
				percentage: (seconds / stats.totalSeconds) * 100
			});
		}

		// 按时长降序排序
		result.sort((a, b) => b.seconds - a.seconds);

		return result;
	}

	// 格式化时长
	public static formatDuration(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const secs = seconds % 60;

		if (hours > 0) {
			return `${hours}小时${minutes}分钟`;
		} else if (minutes > 0) {
			return `${minutes}分钟${secs}秒`;
		} else {
			return `${secs}秒`;
		}
	}

	// 心跳检测
	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			if (this.isTracking) {
				const now = Date.now();
				// 检查是否超过空闲时间
				if (now - this.lastActivityTime > this.IDLE_TIMEOUT_MS) {
					console.log('检测到空闲，结束当前会话');
					this.endCurrentSession();
				}
			}
		}, this.HEARTBEAT_INTERVAL_MS);
	}

	// 停止心跳
	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	// 清理资源
	public dispose(): void {
		this.endCurrentSession();
		this.stopHeartbeat();
		this._onStatsUpdated.dispose();
	}

	// 获取所有存储的日期
	public getAllStoredDates(): string[] {
		const keys = this.context.globalState.keys();
		const dates: string[] = [];

		for (const key of keys) {
			if (key.startsWith('editStats_')) {
				dates.push(key.replace('editStats_', ''));
			}
		}

		return dates.sort();
	}

	// 清除指定日期的数据
	public clearDailyStats(dateKey: string): void {
		const storageKey = `editStats_${dateKey}`;
		this.context.globalState.update(storageKey, undefined);
	}

	// 清除所有数据
	public clearAllStats(): void {
		const dates = this.getAllStoredDates();
		for (const date of dates) {
			this.clearDailyStats(date);
		}
	}
}
