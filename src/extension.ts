import * as vscode from 'vscode';
import simpleGit, { SimpleGit, LogResult } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import { ActivityTracker, DailyEditStats, getLanguageDisplayName } from './activityTracker';

interface CommitDetail {
	date: Date;
	message: string;
	hash: string;
}

interface DayWork {
	day: string;
	firstCommit: Date;
	lastCommit: Date;
	hours: number;
	commits: CommitDetail[];
}

interface WorkRecord {
	author: string;
	commits: number;
	commitDetails: CommitDetail[];
	dailyWork: DayWork[];
	totalHours: number;
}

class WorkHoursViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _tracker: ActivityTracker;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _context: vscode.ExtensionContext
	) {
		this._tracker = ActivityTracker.getInstance(_context);
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		console.log('WorkHoursViewProvider.resolveWebviewView 被调用');
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		this.updateWebviewContent();
		console.log('Webview HTML 已设置');

		// 监听统计更新事件
		this._tracker.onStatsUpdated(() => {
			this.updateWebviewContent();
		});

		// 定时刷新（每30秒）
		const refreshInterval = setInterval(() => {
			if (this._view?.visible) {
				this.updateWebviewContent();
			}
		}, 30000);

		webviewView.onDidDispose(() => {
			clearInterval(refreshInterval);
		});

		webviewView.webview.onDidReceiveMessage(async message => {
			if (message.command === 'upload') {
				await this.handleUpload(message.since);
			} else if (message.command === 'refresh') {
				this.updateWebviewContent();
			} else if (message.command === 'showReport') {
				vscode.commands.executeCommand('workhoursrecord.showWorkHours');
			} else if (message.command === 'showGitHours') {
				await this.showGitHoursPanel(message.since);
			}
		});
	}

	private async handleUpload(since: string | null) {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('请先打开一个工作区');
			return;
		}

		const git: SimpleGit = simpleGit(workspaceFolder.uri.fsPath);
		try {
			const log: LogResult = await git.log(since ? { '--after': `${since} 00:00:00` } : {});
			const records = new Map<string, WorkRecord>();

			log.all.forEach(commit => {
				const author = commit.author_name;
				if (!records.has(author)) {
					records.set(author, { author, commits: 0, commitDetails: [], dailyWork: [], totalHours: 0 });
				}
				const record = records.get(author)!;
				record.commits++;
				record.commitDetails.push({ date: new Date(commit.date), message: commit.message, hash: commit.hash });
			});

			records.forEach(record => {
				record.commitDetails.sort((a, b) => a.date.getTime() - b.date.getTime());
				const dayMap = new Map<string, CommitDetail[]>();
				record.commitDetails.forEach(commit => {
					const day = commit.date.toLocaleDateString();
					if (!dayMap.has(day)) dayMap.set(day, []);
					dayMap.get(day)!.push(commit);
				});
				dayMap.forEach((commits, day) => {
					const first = commits[0].date;
					const last = commits[commits.length - 1].date;
					const hours = (last.getTime() - first.getTime()) / (1000 * 60 * 60);
					record.dailyWork.push({ day, firstCommit: first, lastCommit: last, hours, commits });
					record.totalHours += hours;
				});
			});

			vscode.window.showInformationMessage(`工时数据已准备完成（模拟上传）\n总工时: ${Array.from(records.values()).reduce((sum, r) => sum + r.totalHours, 0).toFixed(2)} 小时`);
		} catch (error: unknown) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg.includes('not a git repository')) {
				vscode.window.showWarningMessage('当前项目未初始化 Git，请先运行 "git init" 初始化仓库');
			} else {
				vscode.window.showErrorMessage(`读取 Git 记录失败: ${errorMsg}`);
			}
		}
	}

	public updateWebviewContent() {
		if (!this._view) return;
		this._view.webview.html = this.getHtmlContent();
	}

	private getHtmlContent(): string {
		const todayStats = this._tracker.getTodayStats();
		const languagePercentages = this._tracker.getLanguagePercentages(todayStats);

		// 生成语言统计 HTML
		let languageStatsHtml = '';
		if (languagePercentages.length > 0) {
			languageStatsHtml = languagePercentages.map(lang => {
				const color = this.getLanguageColor(lang.language);
				return `
					<div class="lang-item">
						<div class="lang-header">
							<span class="lang-name">${lang.displayName}</span>
							<span class="lang-time">${ActivityTracker.formatDuration(lang.seconds)}</span>
						</div>
						<div class="progress-bar">
							<div class="progress-fill" style="width:${lang.percentage}%;background:${color}"></div>
						</div>
						<div class="lang-percent">${lang.percentage.toFixed(1)}%</div>
					</div>
				`;
			}).join('');
		} else {
			languageStatsHtml = '<div class="no-data">暂无编辑数据，开始编码吧！</div>';
		}

		return `<!DOCTYPE html>
<html>
<head>
<style>
:root{--vscode-foreground:#333;--vscode-descriptionForeground:#666;--vscode-button-background:#007acc;--vscode-button-hoverBackground:#005a9e;--vscode-input-background:#fff;--vscode-input-border:#ddd;--vscode-sideBar-background:#f8f9fa;--vscode-textLink-foreground:#007acc}
body{padding:10px;font-family:var(--vscode-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif);font-size:13px;color:var(--vscode-foreground)}
.section{margin:15px 0}
.section-title{font-weight:600;margin-bottom:10px;color:var(--vscode-foreground);display:flex;align-items:center;justify-content:space-between;flex-wrap:nowrap;gap:8px}
.section-title span{white-space:nowrap}
.section-title .refresh-btn{background:var(--vscode-button-secondaryBackground,#6c757d);border:none;cursor:pointer;font-size:16px;padding:4px 10px;color:var(--vscode-button-secondaryForeground,white);border-radius:4px;flex-shrink:0;width:auto;margin:0}
.section-title .refresh-btn:hover{background:var(--vscode-button-secondaryHoverBackground,#545b62)}
label{display:block;margin-bottom:5px;font-weight:500;color:var(--vscode-descriptionForeground)}
input{width:100%;padding:8px;box-sizing:border-box;margin-bottom:10px;border:1px solid var(--vscode-input-border);border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-foreground)}
button{width:100%;padding:10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground,white);border:none;cursor:pointer;font-size:13px;border-radius:4px;margin-bottom:8px}
button:hover{background:var(--vscode-button-hoverBackground)}
button.secondary{background:var(--vscode-button-secondaryBackground,#6c757d);color:var(--vscode-button-secondaryForeground,white)}
button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground,#545b62)}
.stats-card{background:var(--vscode-sideBar-background);padding:12px;border-radius:6px;margin-bottom:15px}
.stats-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.stats-title{font-size:12px;color:var(--vscode-descriptionForeground)}
.stats-value{font-size:24px;font-weight:600;color:var(--vscode-textLink-foreground)}
.lang-item{margin:8px 0}
.lang-header{display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px}
.lang-name{color:var(--vscode-foreground);font-weight:500}
.lang-time{color:var(--vscode-descriptionForeground)}
.progress-bar{height:6px;background:var(--vscode-input-border);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;border-radius:3px;transition:width 0.3s}
.lang-percent{font-size:11px;color:var(--vscode-descriptionForeground);text-align:right;margin-top:2px}
.no-data{color:var(--vscode-descriptionForeground);font-size:12px;text-align:center;padding:20px 0}
.info{background:var(--vscode-textBlockQuote-background,rgba(0,122,204,0.1));padding:10px;border-radius:4px;margin-top:15px;font-size:11px;color:var(--vscode-textLink-foreground);border-left:3px solid var(--vscode-textLink-foreground)}
.divider{height:1px;background:var(--vscode-input-border);margin:15px 0}
</style>
</head>
<body>
<div class="section">
	<div class="section-title">
		<span>今日编码统计</span>
		<button class="refresh-btn" onclick="refresh()" title="刷新">↻</button>
	</div>
	<div class="stats-card">
		<div class="stats-header">
			<span class="stats-title">实际编码时间</span>
		</div>
		<div class="stats-value">${ActivityTracker.formatDuration(todayStats.totalSeconds)}</div>
	</div>
</div>

<div class="section">
	<div class="section-title">语言分布</div>
	${languageStatsHtml}
</div>

<div class="divider"></div>

<div class="section">
	<div class="section-title">Git 工时统计</div>
	<label>统计起始日期</label>
	<input type="date" id="sinceDate" placeholder="留空则统计全部">
	<button onclick="showGitHours()">查看 Git 工时</button>
	<button class="secondary" onclick="showReport()">查看编码报告</button>
	<button class="secondary" onclick="upload()">上传工时到服务器</button>
</div>

<div class="info">
<strong>说明：</strong><br>
• 编码时间：监听编辑活动自动记录<br>
• Git工时：基于提交时间差计算<br>
• 5分钟无操作自动暂停计时
</div>

<script>
const vscode=acquireVsCodeApi();
function upload(){
	const since=document.getElementById('sinceDate').value;
	vscode.postMessage({command:'upload',since:since||null});
}
function refresh(){
	vscode.postMessage({command:'refresh'});
}
function showReport(){
	vscode.postMessage({command:'showReport'});
}
function showGitHours(){
	const since=document.getElementById('sinceDate').value;
	vscode.postMessage({command:'showGitHours',since:since||null});
}
</script>
</body>
</html>`;
	}

	private async showGitHoursPanel(since: string | null) {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('请先打开一个工作区');
			return;
		}

		const git: SimpleGit = simpleGit(workspaceFolder.uri.fsPath);
		try {
			const log: LogResult = await git.log(since ? { '--after': `${since} 00:00:00` } : {});
			const records = new Map<string, WorkRecord>();

			log.all.forEach(commit => {
				const author = commit.author_name;
				if (!records.has(author)) {
					records.set(author, { author, commits: 0, commitDetails: [], dailyWork: [], totalHours: 0 });
				}
				const record = records.get(author)!;
				record.commits++;
				record.commitDetails.push({ date: new Date(commit.date), message: commit.message, hash: commit.hash });
			});

			records.forEach(record => {
				record.commitDetails.sort((a, b) => a.date.getTime() - b.date.getTime());
				const dayMap = new Map<string, CommitDetail[]>();
				record.commitDetails.forEach(commit => {
					const day = commit.date.toLocaleDateString();
					if (!dayMap.has(day)) dayMap.set(day, []);
					dayMap.get(day)!.push(commit);
				});
				dayMap.forEach((commits, day) => {
					const first = commits[0].date;
					const last = commits[commits.length - 1].date;
					const hours = (last.getTime() - first.getTime()) / (1000 * 60 * 60);
					record.dailyWork.push({ day, firstCommit: first, lastCommit: last, hours, commits });
					record.totalHours += hours;
				});
				record.dailyWork.sort((a, b) => a.firstCommit.getTime() - b.firstCommit.getTime());
			});

			this.showGitWorkHourPanel(records, since);
		} catch (error: unknown) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg.includes('not a git repository')) {
				vscode.window.showWarningMessage('当前项目未初始化 Git，请先运行 "git init" 初始化仓库');
			} else {
				vscode.window.showErrorMessage(`读取 Git 记录失败: ${errorMsg}`);
			}
		}
	}

	private showGitWorkHourPanel(records: Map<string, WorkRecord>, since: string | null) {
		const panel = vscode.window.createWebviewPanel(
			'gitWorkHours',
			'Git 工时统计',
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		const totalHours = Array.from(records.values()).reduce((sum, r) => sum + r.totalHours, 0);
		const totalCommits = Array.from(records.values()).reduce((sum, r) => sum + r.commits, 0);

		let html = `<!DOCTYPE html>
<html>
<head>
<style>
:root{--bg-color:#f5f5f5;--card-bg:white;--text-color:#333;--text-secondary:#666;--text-muted:#999;--accent-color:#007acc;--border-color:#eee;--hover-bg:#f8f9fa}
@media(prefers-color-scheme:dark){:root{--bg-color:#1e1e1e;--card-bg:#252526;--text-color:#cccccc;--text-secondary:#9d9d9d;--text-muted:#6d6d6d;--accent-color:#3794ff;--border-color:#3c3c3c;--hover-bg:#2a2d2e}}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:30px;max-width:1200px;margin:0 auto;background:var(--bg-color);color:var(--text-color)}
h1{color:var(--text-color);border-bottom:2px solid var(--accent-color);padding-bottom:10px}
h2{color:var(--text-secondary);margin-top:30px}
h3{color:var(--text-color);margin-top:20px}
.summary-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:20px;margin:20px 0}
.card{background:var(--card-bg);padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
.card-title{font-size:14px;color:var(--text-secondary);margin-bottom:8px}
.card-value{font-size:28px;font-weight:600;color:var(--accent-color)}
.card-subtitle{font-size:12px;color:var(--text-muted);margin-top:5px}
table{border-collapse:collapse;width:100%;margin:20px 0;background:var(--card-bg);border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
th,td{padding:12px 15px;text-align:left;border-bottom:1px solid var(--border-color)}
th{background:var(--accent-color);color:white;font-weight:500}
tr:hover{background:var(--hover-bg)}
.commit-item{margin:5px 0;padding:8px 12px;background:var(--hover-bg);border-left:3px solid var(--accent-color);font-size:12px;border-radius:0 4px 4px 0}
.commit-time{color:var(--accent-color);font-weight:500}
.commit-msg{color:var(--text-color);margin-left:10px}
.commit-hash{color:var(--text-muted);font-size:11px;margin-left:10px}
.no-data{color:var(--text-muted);text-align:center;padding:40px}
.date-range{color:var(--text-secondary);font-size:14px;margin-top:5px}
</style>
</head>
<body>
<h1>Git 工时统计</h1>
<p class="date-range">统计范围：${since ? `${since} 至今` : '全部提交记录'}</p>

<div class="summary-cards">
	<div class="card">
		<div class="card-title">总工时</div>
		<div class="card-value">${totalHours.toFixed(2)}h</div>
		<div class="card-subtitle">基于提交时间差计算</div>
	</div>
	<div class="card">
		<div class="card-title">总提交数</div>
		<div class="card-value">${totalCommits}</div>
		<div class="card-subtitle">Git 提交次数</div>
	</div>
	<div class="card">
		<div class="card-title">开发者数</div>
		<div class="card-value">${records.size}</div>
		<div class="card-subtitle">参与开发人数</div>
	</div>
</div>`;

		if (records.size === 0) {
			html += `<div class="no-data">暂无 Git 提交记录</div>`;
		} else {
			records.forEach(record => {
				html += `<h2>${record.author}</h2>
<p style="color:var(--text-secondary)">总工时: ${record.totalHours.toFixed(2)} 小时 | 提交次数: ${record.commits}</p>
<table>
<tr><th>日期</th><th>工作时长</th><th>首次提交</th><th>最后提交</th><th>提交数</th></tr>`;

				record.dailyWork.forEach(day => {
					html += `<tr>
<td>${day.day}</td>
<td>${day.hours.toFixed(2)} 小时</td>
<td>${day.firstCommit.toLocaleTimeString()}</td>
<td>${day.lastCommit.toLocaleTimeString()}</td>
<td>${day.commits.length}</td>
</tr>`;
				});

				html += `</table><h3>提交详情</h3>`;

				record.dailyWork.forEach(day => {
					html += `<p style="font-weight:600;margin-top:15px">${day.day}</p>`;
					day.commits.forEach(commit => {
						html += `<div class="commit-item">
<span class="commit-time">${commit.date.toLocaleTimeString()}</span>
<span class="commit-msg">${commit.message}</span>
<span class="commit-hash">(${commit.hash.substring(0, 7)})</span>
</div>`;
					});
				});
			});
		}

		html += `</body></html>`;
		panel.webview.html = html;
	}

	private getLanguageColor(languageId: string): string {
		const colors: { [key: string]: string } = {
			'javascript': '#f7df1e',
			'typescript': '#3178c6',
			'typescriptreact': '#61dafb',
			'javascriptreact': '#61dafb',
			'python': '#3776ab',
			'java': '#b07219',
			'csharp': '#178600',
			'cpp': '#f34b7d',
			'c': '#555555',
			'go': '#00add8',
			'rust': '#dea584',
			'ruby': '#cc342d',
			'php': '#4f5d95',
			'swift': '#fa7343',
			'kotlin': '#a97bff',
			'html': '#e34c26',
			'css': '#563d7c',
			'scss': '#c6538c',
			'json': '#292929',
			'yaml': '#cb171e',
			'markdown': '#083fa1',
			'sql': '#e38c00',
			'shellscript': '#89e051',
			'vue': '#41b883',
			'svelte': '#ff3e00',
		};
		return colors[languageId] || '#6c757d';
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('工时记录插件已激活');

	// 初始化活动追踪器
	const tracker = ActivityTracker.getInstance(context);
	const trackerDisposables = tracker.initialize();
	trackerDisposables.forEach(d => context.subscriptions.push(d));

	const provider = new WorkHoursViewProvider(context.extensionUri, context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('workhoursrecordView', provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	const showWorkHours = vscode.commands.registerCommand('workhoursrecord.showWorkHours', async () => {
		showCombinedWorkHourPanel(context, tracker);
	});

	const exportCSV = vscode.commands.registerCommand('workhoursrecord.exportCSV', async () => {
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
		if (!workspaceFolder) {
			vscode.window.showErrorMessage('请先打开一个工作区');
			return;
		}

		const git: SimpleGit = simpleGit(workspaceFolder.uri.fsPath);

		try {
			const since = await vscode.window.showInputBox({
				prompt: '输入统计起始日期（格式：YYYY-MM-DD，留空则统计全部）',
				placeHolder: '例如：2025-01-01'
			});

			const log: LogResult = await git.log(since ? { '--after': `${since} 00:00:00` } : {});
			const records = new Map<string, WorkRecord>();

			log.all.forEach(commit => {
				const author = commit.author_name;
				if (!records.has(author)) {
					records.set(author, {
						author,
						commits: 0,
						commitDetails: [],
						dailyWork: [],
						totalHours: 0
					});
				}
				const record = records.get(author)!;
				record.commits++;
				record.commitDetails.push({
					date: new Date(commit.date),
					message: commit.message,
					hash: commit.hash
				});
			});

			records.forEach(record => {
				record.commitDetails.sort((a, b) => a.date.getTime() - b.date.getTime());
				const dayMap = new Map<string, CommitDetail[]>();
				record.commitDetails.forEach(commit => {
					const day = commit.date.toLocaleDateString();
					if (!dayMap.has(day)) {
						dayMap.set(day, []);
					}
					dayMap.get(day)!.push(commit);
				});

				dayMap.forEach((commits, day) => {
					const first = commits[0].date;
					const last = commits[commits.length - 1].date;
					const hours = (last.getTime() - first.getTime()) / (1000 * 60 * 60);
					record.dailyWork.push({ day, firstCommit: first, lastCommit: last, hours, commits });
					record.totalHours += hours;
				});
				record.dailyWork.sort((a, b) => a.firstCommit.getTime() - b.firstCommit.getTime());
			});

			// 获取编辑统计数据
			const editDates = tracker.getAllStoredDates();
			const editStatsMap = new Map<string, DailyEditStats>();
			editDates.forEach(date => {
				const stats = tracker.getDailyStats(date);
				if (stats.totalSeconds > 0) {
					editStatsMap.set(date, stats);
				}
			});

			// 生成 CSV
			let csv = '日期,Git工时(小时),实际编码时间,主要语言,语言详情,提交次数\n';

			// 合并所有日期
			const allDates = new Set<string>();
			records.forEach(record => {
				record.dailyWork.forEach(day => {
					const dateStr = new Date(day.firstCommit).toISOString().split('T')[0];
					allDates.add(dateStr);
				});
			});
			editDates.forEach(date => allDates.add(date));

			const sortedDates = Array.from(allDates).sort();

			sortedDates.forEach(dateStr => {
				let gitHours = 0;
				let commitCount = 0;

				records.forEach(record => {
					record.dailyWork.forEach(day => {
						const dayDateStr = new Date(day.firstCommit).toISOString().split('T')[0];
						if (dayDateStr === dateStr) {
							gitHours += day.hours;
							commitCount += day.commits.length;
						}
					});
				});

				const editStats = editStatsMap.get(dateStr);
				const editTime = editStats ? ActivityTracker.formatDuration(editStats.totalSeconds) : '0';

				let mainLang = '-';
				let langDetails = '-';
				if (editStats) {
					const langPercentages = tracker.getLanguagePercentages(editStats);
					if (langPercentages.length > 0) {
						mainLang = langPercentages[0].displayName;
						langDetails = langPercentages.map(l => `${l.displayName}:${l.percentage.toFixed(1)}%`).join('; ');
					}
				}

				csv += `"${dateStr}",${gitHours.toFixed(2)},"${editTime}","${mainLang}","${langDetails}",${commitCount}\n`;
			});

			const savePath = path.join(workspaceFolder.uri.fsPath, `工时统计_${new Date().toISOString().split('T')[0]}.csv`);
			fs.writeFileSync(savePath, '\ufeff' + csv);
			vscode.window.showInformationMessage(`已导出到: ${savePath}`);
		} catch (error) {
			vscode.window.showErrorMessage(`导出失败: ${error}`);
		}
	});

	context.subscriptions.push(showWorkHours, exportCSV);

	// 注册清除数据命令
	const clearStats = vscode.commands.registerCommand('workhoursrecord.clearStats', async () => {
		const confirm = await vscode.window.showWarningMessage(
			'确定要清除所有编辑统计数据吗？此操作不可恢复。',
			'确定', '取消'
		);
		if (confirm === '确定') {
			tracker.clearAllStats();
			vscode.window.showInformationMessage('编辑统计数据已清除');
		}
	});
	context.subscriptions.push(clearStats);
}

function showCombinedWorkHourPanel(context: vscode.ExtensionContext, tracker: ActivityTracker) {
	const panel = vscode.window.createWebviewPanel(
		'workHours',
		'工时统计报告',
		vscode.ViewColumn.One,
		{ enableScripts: true }
	);

	// 获取编辑统计
	const editDates = tracker.getAllStoredDates();
	const editStatsMap = new Map<string, DailyEditStats>();
	let totalEditSeconds = 0;
	const totalLanguageStats: { [key: string]: number } = {};

	editDates.forEach(date => {
		const stats = tracker.getDailyStats(date);
		if (stats.totalSeconds > 0) {
			editStatsMap.set(date, stats);
			totalEditSeconds += stats.totalSeconds;
			for (const [lang, seconds] of Object.entries(stats.languageStats)) {
				totalLanguageStats[lang] = (totalLanguageStats[lang] || 0) + seconds;
			}
		}
	});

	// 计算语言占比
	const languagePercentages: { language: string; displayName: string; seconds: number; percentage: number }[] = [];
	for (const [lang, seconds] of Object.entries(totalLanguageStats)) {
		languagePercentages.push({
			language: lang,
			displayName: getLanguageDisplayName(lang),
			seconds,
			percentage: totalEditSeconds > 0 ? (seconds / totalEditSeconds) * 100 : 0
		});
	}
	languagePercentages.sort((a, b) => b.seconds - a.seconds);

	// 生成语言颜色
	const getColor = (lang: string): string => {
		const colors: { [key: string]: string } = {
			'javascript': '#f7df1e', 'typescript': '#3178c6', 'python': '#3776ab',
			'java': '#b07219', 'go': '#00add8', 'rust': '#dea584', 'html': '#e34c26',
			'css': '#563d7c', 'vue': '#41b883', 'typescriptreact': '#61dafb'
		};
		return colors[lang] || '#6c757d';
	};

	let html = `<!DOCTYPE html>
<html>
<head>
<style>
:root{--bg-color:#f5f5f5;--card-bg:white;--text-color:#333;--text-secondary:#666;--text-muted:#999;--accent-color:#007acc;--border-color:#eee;--hover-bg:#f8f9fa}
@media(prefers-color-scheme:dark){:root{--bg-color:#1e1e1e;--card-bg:#252526;--text-color:#cccccc;--text-secondary:#9d9d9d;--text-muted:#6d6d6d;--accent-color:#3794ff;--border-color:#3c3c3c;--hover-bg:#2a2d2e}}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:30px;max-width:1200px;margin:0 auto;background:var(--bg-color);color:var(--text-color)}
h1{color:var(--text-color);border-bottom:2px solid var(--accent-color);padding-bottom:10px}
h2{color:var(--text-secondary);margin-top:30px}
h3{color:var(--text-color)}
.summary-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin:20px 0}
.card{background:var(--card-bg);padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
.card-title{font-size:14px;color:var(--text-secondary);margin-bottom:8px}
.card-value{font-size:28px;font-weight:600;color:var(--accent-color)}
.card-subtitle{font-size:12px;color:var(--text-muted);margin-top:5px}
.lang-chart{background:var(--card-bg);padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);margin:20px 0}
.lang-bar{display:flex;height:30px;border-radius:4px;overflow:hidden;margin:15px 0}
.lang-segment{transition:all 0.3s}
.lang-legend{display:flex;flex-wrap:wrap;gap:15px;margin-top:15px}
.legend-item{display:flex;align-items:center;font-size:13px;color:var(--text-color)}
.legend-color{width:12px;height:12px;border-radius:2px;margin-right:6px}
table{border-collapse:collapse;width:100%;margin:20px 0;background:var(--card-bg);border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
th,td{padding:12px 15px;text-align:left;border-bottom:1px solid var(--border-color)}
th{background:var(--accent-color);color:white;font-weight:500}
tr:hover{background:var(--hover-bg)}
.no-data{color:var(--text-muted);text-align:center;padding:40px}
</style>
</head>
<body>
<h1>工时统计报告</h1>

<div class="summary-cards">
	<div class="card">
		<div class="card-title">总编码时间</div>
		<div class="card-value">${ActivityTracker.formatDuration(totalEditSeconds)}</div>
		<div class="card-subtitle">基于编辑活动监测</div>
	</div>
	<div class="card">
		<div class="card-title">统计天数</div>
		<div class="card-value">${editDates.length}</div>
		<div class="card-subtitle">有编码活动的天数</div>
	</div>
	<div class="card">
		<div class="card-title">使用语言数</div>
		<div class="card-value">${languagePercentages.length}</div>
		<div class="card-subtitle">不同编程语言</div>
	</div>
	<div class="card">
		<div class="card-title">日均编码</div>
		<div class="card-value">${editDates.length > 0 ? ActivityTracker.formatDuration(Math.floor(totalEditSeconds / editDates.length)) : '0'}</div>
		<div class="card-subtitle">平均每天编码时间</div>
	</div>
</div>`;

	// 语言分布图
	if (languagePercentages.length > 0) {
		html += `
<div class="lang-chart">
	<h3>语言分布</h3>
	<div class="lang-bar">`;

		languagePercentages.forEach(lang => {
			html += `<div class="lang-segment" style="width:${lang.percentage}%;background:${getColor(lang.language)}" title="${lang.displayName}: ${lang.percentage.toFixed(1)}%"></div>`;
		});

		html += `</div>
	<div class="lang-legend">`;

		languagePercentages.forEach(lang => {
			html += `<div class="legend-item"><div class="legend-color" style="background:${getColor(lang.language)}"></div>${lang.displayName}: ${ActivityTracker.formatDuration(lang.seconds)} (${lang.percentage.toFixed(1)}%)</div>`;
		});

		html += `</div></div>`;
	}

	// 每日详情表格
	html += `<h2>每日编码详情</h2>`;

	if (editDates.length > 0) {
		html += `<table>
<tr><th>日期</th><th>编码时间</th><th>主要语言</th><th>语言详情</th></tr>`;

		editDates.sort().reverse().forEach(date => {
			const stats = editStatsMap.get(date);
			if (stats && stats.totalSeconds > 0) {
				const dayLangPercentages = tracker.getLanguagePercentages(stats);
				const mainLang = dayLangPercentages.length > 0 ? dayLangPercentages[0].displayName : '-';
				const langDetails = dayLangPercentages.map(l => `${l.displayName}: ${l.percentage.toFixed(1)}%`).join(', ');

				html += `<tr>
<td>${date}</td>
<td>${ActivityTracker.formatDuration(stats.totalSeconds)}</td>
<td>${mainLang}</td>
<td style="font-size:12px;color:#666">${langDetails}</td>
</tr>`;
			}
		});

		html += `</table>`;
	} else {
		html += `<div class="no-data">暂无编码数据</div>`;
	}

	html += `</body></html>`;
	panel.webview.html = html;
}

export function deactivate() {
	const tracker = ActivityTracker.getInstance();
	tracker.dispose();
}
