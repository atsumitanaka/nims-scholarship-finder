/**
 * NIMS 奨学金・制度検索 - メインJavaScript
 */

document.addEventListener('DOMContentLoaded', function() {
    // DOM要素
    const nationalitySelect = document.getElementById('nationality');
    const currentEducationSelect = document.getElementById('current_education');
    const desiredPathSelect = document.getElementById('desired_path');
    const intakeYearInput = document.getElementById('intake_year');
    const intakeMonthPartSelect = document.getElementById('intake_month_part');
    const tsukubaSelect = document.getElementById('tsukuba');
    const searchBtn = document.getElementById('search-btn');
    const resetBtn = document.getElementById('reset-btn');
    const resultsContainer = document.getElementById('results-container');
    const resultCount = document.getElementById('result-count');
    const lastUpdated = document.getElementById('last-updated');
    const timelineSection = document.getElementById('timeline-section');
    const timelineContainer = document.getElementById('timeline-container');
    const clearSelectionBtn = document.getElementById('clear-selection-btn');

    // 選択されたスケジュールを保持
    // key: `${programId}::${scheduleIndex}`
    // value: { program, schedule, scheduleIndex }
    let selectedSchedules = new Map();
    let allPrograms = [];

    const SCHEDULE_KEY_SEP = '::';
    const scheduleKey = (programId, idx) => `${programId}${SCHEDULE_KEY_SEP}${idx}`;

    // 元データ（アクセスごとに再取得）
    const DATA_URL = 'data/scholarships.json';
    const FAR_FUTURE = new Date(9999, 11, 31);
    let rawData = null;

    // イベントリスナー
    searchBtn.addEventListener('click', searchPrograms);
    resetBtn.addEventListener('click', resetForm);
    clearSelectionBtn.addEventListener('click', clearSelection);

    // 入学希望時期変更時にタイムラインも更新
    intakeYearInput.addEventListener('input', updateTimeline);
    intakeMonthPartSelect.addEventListener('change', updateTimeline);

    /**
     * 年テキスト + 季節セレクトを内部フィルタ値に変換
     *   - 年も季節も空: ''
     *   - 年だけ:    'YYYY-any'
     *   - 季節だけ:  'any-spring' / 'any-autumn'
     *   - 両方:      'YYYY-spring' / 'YYYY-autumn'
     */
    function getIntakeFilterValue() {
        const yearRaw = (intakeYearInput.value || '').trim();
        const season = intakeMonthPartSelect.value;
        const yearValid = /^\d{4}$/.test(yearRaw);
        if (!yearValid && !season) return '';
        if (!yearValid && season) return `any-${season}`;
        if (yearValid && !season) return `${yearRaw}-any`;
        return `${yearRaw}-${season}`;
    }

    // 初期表示：全プログラムを表示
    searchPrograms();

    /**
     * scholarships.json を毎回キャッシュ無効で取得
     */
    async function loadScholarships() {
        const url = `${DATA_URL}?v=${Date.now()}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Failed to load data: ${response.status}`);
        }
        return response.json();
    }

    /**
     * 締切日文字列をパース
     */
    function parseDeadline(deadlineStr) {
        if (!deadlineStr) return FAR_FUTURE;
        if (deadlineStr.includes('随時')) return FAR_FUTURE;

        const patterns = [
            /(\d{4})年[^月\d]*(\d{1,2})月(\d{1,2})日/,
            /(\d{4})年[^月\d]*(\d{1,2})月/,
            /(\d{4})\/(\d{1,2})\/(\d{1,2})/
        ];

        for (const pattern of patterns) {
            const m = deadlineStr.match(pattern);
            if (m) {
                const year = parseInt(m[1]);
                const month = parseInt(m[2]) - 1;
                const day = m[3] ? parseInt(m[3]) : 1;
                return new Date(year, month, day);
            }
        }
        return FAR_FUTURE;
    }

    /**
     * 締切が過ぎているか
     */
    function isDeadlinePassed(deadlineStr) {
        if (!deadlineStr) return false;
        if (deadlineStr.includes('随時')) return false;
        const d = parseDeadline(deadlineStr);
        if (d.getTime() === FAR_FUTURE.getTime()) return false;
        return d < new Date();
    }

    const DEADLINE_KEYS = ['deadline', 'document_deadline', 'university_contact_deadline'];
    const ALL_DATE_KEYS = [
        'arrival_date', 'result', 'result_notification', 'second_result',
        'enrollment_procedure', 'adoption_date',
        'exam_date', 'interview', 'first_result',
        'deadline', 'document_deadline', 'university_contact_deadline',
        'web_registration', 'application_start'
    ];

    function getLatestScheduleDate(s) {
        let latest = null;
        for (const key of ALL_DATE_KEYS) {
            if (!s[key]) continue;
            const d = parseDate(s[key]);
            if (d.getFullYear() === 9999) continue;
            if (!latest || d > latest) latest = d;
        }
        return latest;
    }

    function isScheduleExpired(s) {
        const latest = getLatestScheduleDate(s);
        return latest ? latest < new Date() : false;
    }

    /**
     * プログラムの最も近い将来の締切日を取得（ソート用）
     */
    function getNearestDeadline(program) {
        const schedules = program.application_schedule || [];
        if (schedules.length === 0) return FAR_FUTURE;
        let nearest = FAR_FUTURE;
        const now = new Date();
        for (const s of schedules) {
            for (const key of DEADLINE_KEYS) {
                if (!s[key]) continue;
                const d = parseDeadline(s[key]);
                if (d >= now && d < nearest) nearest = d;
            }
        }
        return nearest;
    }

    /**
     * プログラム一覧を条件でフィルタ（旧サーバー側 filter_programs の移植）
     */
    function filterPrograms(programs, filters) {
        const { nationality, current_education, desired_path, intake_month, tsukuba } = filters;
        const results = [];

        for (const original of programs) {
            const allSchedules = original.application_schedule || [];
            if (allSchedules.length === 0) continue;

            const program = { ...original };

            if (nationality && !(program.target_nationality || []).includes(nationality)) continue;
            if (current_education && !(program.current_education || []).includes(current_education)) continue;
            if (desired_path && !(program.desired_path || []).includes(desired_path)) continue;

            if (intake_month) {
                const hasMatch = allSchedules.some(s => {
                    const intake = s.intake || '';
                    const adoptionPeriod = s.adoption_period || '';
                    const adoptionDate = s.adoption_date || '';
                    return intake.includes(intake_month) ||
                        matchesIntakeFilter(intake, intake_month) ||
                        matchesIntakeFilter(adoptionPeriod, intake_month) ||
                        matchesIntakeFilter(adoptionDate, intake_month);
                });
                if (!hasMatch) continue;
            }

            if (tsukuba) {
                if (!program.tsukuba_related) continue;
                if (!(program.tsukuba_degree || []).includes(tsukuba)) continue;
            }

            results.push(program);
        }

        results.sort((a, b) => {
            const aHasActive = (a.application_schedule || []).some(s => !isScheduleExpired(s));
            const bHasActive = (b.application_schedule || []).some(s => !isScheduleExpired(s));
            if (aHasActive !== bHasActive) return aHasActive ? -1 : 1;
            return getNearestDeadline(a) - getNearestDeadline(b);
        });
        return results;
    }

    /**
     * プログラム検索
     */
    async function searchPrograms() {
        const filters = {
            nationality: nationalitySelect.value,
            current_education: currentEducationSelect.value,
            desired_path: desiredPathSelect.value,
            intake_month: getIntakeFilterValue(),
            tsukuba: tsukubaSelect.value
        };

        try {
            // アクセスごとに最新の JSON を取得
            rawData = await loadScholarships();

            const programs = filterPrograms(rawData.programs || [], filters);
            allPrograms = programs;

            displayResults(programs);
            resultCount.textContent = `(${programs.length}件)`;
            lastUpdated.textContent = rawData.last_updated || '-';

            restoreSelections();

        } catch (error) {
            console.error('Error fetching programs:', error);
            resultsContainer.innerHTML = '<p class="no-results">データの取得に失敗しました。</p>';
        }
    }

    /**
     * フォームリセット
     */
    function resetForm() {
        nationalitySelect.value = '';
        currentEducationSelect.value = '';
        desiredPathSelect.value = '';
        intakeYearInput.value = '';
        intakeMonthPartSelect.value = '';
        tsukubaSelect.value = '';
        clearSelection();
        searchPrograms();
    }

    /**
     * 選択をクリア
     */
    function clearSelection() {
        selectedSchedules.clear();
        document.querySelectorAll('.schedule-item.selected').forEach(el => {
            el.classList.remove('selected');
        });
        document.querySelectorAll('.schedule-checkbox').forEach(checkbox => {
            checkbox.checked = false;
        });
        updateTimeline();
    }

    /**
     * 選択状態を復元（再描画後に呼ぶ）。
     * 表示中のチェックボックスを selectedSchedules に合わせて反映。
     * 既に Map から消えた制度がある場合は selectedSchedules からも除去。
     */
    function restoreSelections() {
        const validKeys = new Set();
        allPrograms.forEach(p => {
            (p.application_schedule || []).forEach((_, idx) => {
                validKeys.add(scheduleKey(p.id, idx));
            });
        });
        Array.from(selectedSchedules.keys()).forEach(k => {
            if (!validKeys.has(k)) selectedSchedules.delete(k);
        });
    }

    /**
     * 個別スケジュール選択のトグル
     */
    function toggleScheduleSelection(programId, scheduleIndex, checkbox) {
        const program = allPrograms.find(p => p.id === programId);
        if (!program) return;
        const schedule = (program.application_schedule || [])[scheduleIndex];
        if (!schedule) return;

        const key = scheduleKey(programId, scheduleIndex);
        const itemEl = document.getElementById(`schedule-${programId}-${scheduleIndex}`);

        if (checkbox.checked) {
            selectedSchedules.set(key, { program, schedule, scheduleIndex });
            if (itemEl) itemEl.classList.add('selected');
        } else {
            selectedSchedules.delete(key);
            if (itemEl) itemEl.classList.remove('selected');
        }

        updateTimeline();
    }

    /**
     * タイムライン更新
     */
    function updateTimeline() {
        const mainContent = document.querySelector('.main-content');

        if (selectedSchedules.size === 0) {
            timelineSection.style.display = 'none';
            if (mainContent) mainContent.classList.remove('has-timeline');
            return;
        }

        timelineSection.style.display = 'block';
        if (mainContent) mainContent.classList.add('has-timeline');

        // タイムラインは選択したスケジュールを無条件で表示する
        // （検索フィルタは結果一覧の絞り込み専用）
        const events = collectTimelineEvents();
        renderTimeline(events);
    }

    /**
     * 入学時期がフィルターに一致するかチェック。
     * filterValue は getIntakeFilterValue() の出力形式：
     *   - ''                       : フィルターなし
     *   - 'YYYY-any'               : 年だけ指定（季節は問わない）
     *   - 'any-spring'/'any-autumn': 季節だけ指定（年は問わない）
     *   - 'YYYY-spring'/'YYYY-autumn' : 両方指定
     *
     * 「春」= 4〜9月のいずれか（旧4月・前期と統合）
     * 「秋」= 10〜3月のいずれか（旧10月・後期と統合）
     */
    function matchesIntakeFilter(intakeStr, filterValue) {
        if (!filterValue) return true;
        if (!intakeStr) return false;

        const parts = filterValue.split("-");
        if (parts.length !== 2) return true;

        const targetYearStr = parts[0];
        const targetType = parts[1];
        const isAnyYear = targetYearStr === 'any';
        const targetYear = isAnyYear ? null : parseInt(targetYearStr);

        const isAnySeason = targetType === "any";
        const isSpring = targetType === "spring";
        const isAutumn = targetType === "autumn";

        const inSeason = (month) => {
            if (isAnySeason) return true;
            if (isSpring) return month >= 4 && month <= 9;
            if (isAutumn) return month >= 10 || month <= 3;
            return false;
        };

        // 随時は常に表示
        if (intakeStr.includes('随時')) return true;

        const matchesYear = (y) => isAnyYear || y === targetYear;

        // 年度形式 "2026年度"（月不明）
        const fiscalYearMatch = intakeStr.match(/(\d{4})年度/);
        if (fiscalYearMatch && matchesYear(parseInt(fiscalYearMatch[1]))) {
            // 月不明な intake は「年指定あり」のときだけ通す
            if (!isAnyYear) return true;
        }

        // 範囲表記 "2026年4月1日〜9月30日開始"
        const periodMatch = intakeStr.match(/(\d{4})年(\d{1,2})月.*?[〜~～].*?(\d{1,2})月/);
        if (periodMatch) {
            const periodYear = parseInt(periodMatch[1]);
            const startMonth = parseInt(periodMatch[2]);
            const endMonth = parseInt(periodMatch[3]);
            if (matchesYear(periodYear)) {
                if (isAnySeason) return true;
                if (isSpring && startMonth <= 9) return true;
                if (isAutumn && (startMonth >= 10 || endMonth >= 10)) return true;
            }
        }

        // "YYYY年M月" / "April YYYY" / "October YYYY"
        const patterns = [
            /(\d{4})年(\d{1,2})月/,
            /(April|October)\s*(\d{4})/,
        ];
        for (const pattern of patterns) {
            const match = intakeStr.match(pattern);
            if (!match) continue;
            let year, month;
            if (match[1] === 'April' || match[1] === 'October') {
                month = match[1] === 'April' ? 4 : 10;
                year = parseInt(match[2]);
            } else {
                year = parseInt(match[1]);
                month = parseInt(match[2]);
            }
            if (!matchesYear(year)) continue;
            if (inSeason(month)) return true;
        }

        // フォールバック: "YYYY年" だけが書かれている表記（"2027年7月実施"等）
        const yearOnlyMatch = intakeStr.match(/(\d{4})年/);
        if (yearOnlyMatch && matchesYear(parseInt(yearOnlyMatch[1]))) {
            // 月不明 → 年指定ありの時だけ通す（月だけ指定では判定不能）
            if (!isAnyYear) return true;
        }

        return false;
    }

    /**
     * タイムラインイベントを収集
     */
    function collectTimelineEvents() {
        const events = [];

        // イベントタイプの定義
        const eventTypes = [
            { key: 'application_start', type: 'start', label: '募集開始' },
            { key: 'web_registration', type: 'start', label: 'Web出願期間' },
            { key: 'first_screening', type: 'screening', label: '第1次選考' },
            { key: 'deadline', type: 'deadline', label: '書類提出締切' },
            { key: 'document_deadline', type: 'deadline', label: '書類必着' },
            { key: 'university_contact_deadline', type: 'deadline', label: '大学連絡期限' },
            { key: 'university_recommendation', type: 'screening', label: '大学推薦' },
            { key: 'second_screening', type: 'screening', label: '第2次選考' },
            { key: 'document_screening', type: 'screening', label: '書類審査' },
            { key: 'exam_date', type: 'exam', label: '試験日' },
            { key: 'interview', type: 'exam', label: '面接審査' },
            { key: 'first_result', type: 'result', label: '1次結果発表' },
            { key: 'second_result', type: 'result', label: '2次結果発表' },
            { key: 'result', type: 'result', label: '結果発表' },
            { key: 'result_notification', type: 'result', label: '結果通知予定' },
            { key: 'enrollment_procedure', type: 'procedure', label: '入学手続' },
            { key: 'adoption_date', type: 'adoption', label: '採用日' },
            { key: 'adoption_period', type: 'adoption', label: '採用開始時期' },
            { key: 'arrival_date', type: 'adoption', label: '来日・採用開始' },
            { key: 'internship_period', type: 'period', label: 'インターン期間' }
        ];

        selectedSchedules.forEach(({ program, schedule }) => {
            eventTypes.forEach(eventType => {
                if (schedule[eventType.key]) {
                    events.push({
                        program: program.name,
                        programId: program.id,
                        type: eventType.type,
                        typeLabel: eventType.label,
                        date: schedule[eventType.key],
                        intake: schedule.intake,
                        note: schedule.note || '',
                        sortDate: parseDate(schedule[eventType.key])
                    });
                }
            });
        });

        // 日付でソート
        events.sort((a, b) => a.sortDate - b.sortDate);

        return events;
    }

    /**
     * 日付文字列をパース
     */
    function parseDate(dateStr) {
        if (!dateStr) return new Date(9999, 11, 31);

        // 「随時」などの場合
        if (dateStr.includes('随時')) return new Date(9999, 11, 31);

        // 年月日パターン（「令和8年(2026年)6月2日」のような括弧付き形式にも対応）
        const patterns = [
            /(\d{4})年[^月\d]*(\d{1,2})月(\d{1,2})日/,
            /(\d{4})年[^月\d]*(\d{1,2})月/,
            /(\d{4})\/(\d{1,2})\/(\d{1,2})/
        ];

        for (const pattern of patterns) {
            const match = dateStr.match(pattern);
            if (match) {
                const year = parseInt(match[1]);
                const month = parseInt(match[2]) - 1;
                const day = match[3] ? parseInt(match[3]) : 1;
                return new Date(year, month, day);
            }
        }

        return new Date(9999, 11, 31);
    }

    /**
     * タイムラインを描画
     */
    function renderTimeline(events) {
        if (events.length === 0) {
            timelineContainer.innerHTML = '<p class="no-results">選択したスケジュールに日付情報がありません。</p>';
            return;
        }

        // 月ごとにグループ化
        const monthGroups = {};
        let hasValidEvents = false;

        events.forEach(event => {
            if (event.sortDate.getFullYear() === 9999) return;
            hasValidEvents = true;

            const monthKey = `${event.sortDate.getFullYear()}-${String(event.sortDate.getMonth() + 1).padStart(2, '0')}`;
            const monthLabel = `${event.sortDate.getFullYear()}年${event.sortDate.getMonth() + 1}月`;

            if (!monthGroups[monthKey]) {
                monthGroups[monthKey] = {
                    label: monthLabel,
                    events: []
                };
            }
            monthGroups[monthKey].events.push(event);
        });

        // 選択件数の表示
        const filterInfo = `<div class="timeline-filter-info">📅 ${selectedSchedules.size} 件のスケジュールを比較</div>`;

        // 凡例
        let html = `
            ${filterInfo}
            <div class="timeline-legend">
                <div class="legend-item"><span class="legend-dot start"></span>募集開始</div>
                <div class="legend-item"><span class="legend-dot deadline"></span>締切</div>
                <div class="legend-item"><span class="legend-dot screening"></span>選考・審査</div>
                <div class="legend-item"><span class="legend-dot exam"></span>試験・面接</div>
                <div class="legend-item"><span class="legend-dot result"></span>結果発表</div>
                <div class="legend-item"><span class="legend-dot procedure"></span>手続</div>
                <div class="legend-item"><span class="legend-dot adoption"></span>採用</div>
            </div>
            <div class="timeline">
        `;

        // 月ごとに表示
        const sortedMonths = Object.keys(monthGroups).sort();

        sortedMonths.forEach(monthKey => {
            const group = monthGroups[monthKey];

            html += `
                <div class="timeline-month-group">
                    <div class="timeline-month-header">${group.label}</div>
                    <div class="timeline-events">
            `;

            group.events.forEach(event => {
                const noteHtml = event.note
                    ? `<div class="timeline-event-note">💡 ${event.note}</div>`
                    : '';

                html += `
                    <div class="timeline-event ${event.type}">
                        <div class="timeline-event-header">
                            <span class="timeline-event-program">${event.program}</span>
                            <span class="timeline-event-type ${event.type}">${event.typeLabel}</span>
                        </div>
                        <div class="timeline-event-date">📆 ${event.date}</div>
                        <div class="timeline-event-intake">🎓 ${event.intake}</div>
                        ${noteHtml}
                    </div>
                `;
            });

            html += `
                    </div>
                </div>
            `;
        });

        html += '</div>';

        timelineContainer.innerHTML = html;
    }

    /**
     * 入学月をフォーマット
     */
    function formatIntakeMonth(value) {
        const parts = value.split('-');
        if (parts.length !== 2) return value;
        const year = parts[0];
        const type = parts[1];
        const isAnyYear = year === 'any';
        const yearLabel = isAnyYear ? '任意の年' : `${year}年`;

        if (type === 'any') {
            return yearLabel;
        } else if (type === 'spring') {
            return `${yearLabel} 春（4〜9月）`;
        } else if (type === 'autumn') {
            return `${yearLabel} 秋（10〜3月）`;
        }
        return value;
    }

    /**
     * 結果表示
     */
    function displayResults(programs) {
        if (!programs || programs.length === 0) {
            resultsContainer.innerHTML = `
                <p class="no-results">
                    条件に一致するプログラムが見つかりませんでした。<br>
                    No programs found matching your criteria.
                </p>
            `;
            return;
        }

        const selectedIntake = getIntakeFilterValue();
        const html = programs.map(program => createProgramCard(program, selectedIntake)).join('');
        resultsContainer.innerHTML = html;
    }

    /**
     * プログラムカード生成（2カラムレイアウト）
     */
    function createProgramCard(program, selectedIntake) {
        // タグ生成
        const nationalityTags = program.target_nationality.map(n => {
            const label = n === 'japanese' ? '日本人' : '外国人';
            return `<span class="tag tag-nationality">${label}</span>`;
        }).join('');

        const educationTags = (program.current_education || []).map(e => {
            const labels = {
                'bachelor': '学部',
                'master': '修士',
                'doctor': '博士'
            };
            return `<span class="tag tag-education">${labels[e] || e}</span>`;
        }).join('');

        const pathTags = (program.desired_path || []).map(p => {
            const labels = {
                'master': '→修士',
                'doctor': '→博士',
                'postdoc': '→ポスドク',
                'intern': '→インターン'
            };
            return `<span class="tag tag-path">${labels[p] || p}</span>`;
        }).join('');

        const tsukubaTag = program.tsukuba_related
            ? '<span class="tag tag-tsukuba">筑波大連携</span>'
            : '';

        // 左カラム: 支援内容
        const benefitsHtml = formatBenefits(program.benefits);

        // 左カラム: 必要書類
        const documentsHtml = formatDocuments(program.required_documents);

        // 右カラム: スケジュール（選択された入学時期でフィルタリング）
        const schedulesHtml = formatSchedules(program, selectedIntake);

        // 関連リンク
        const relatedLinks = (program.related_urls || []).map(link =>
            `<a href="${link.url}" target="_blank" rel="noopener" class="program-link program-link-secondary">${link.label}</a>`
        ).join('');

        return `
            <div class="program-card" id="card-${program.id}">
                <div class="program-header">
                    <div>
                        <h3 class="program-title">${program.name}</h3>
                        <p class="program-title-en">${program.name_en}</p>
                        <p class="program-org">${program.organization}</p>
                    </div>
                    <div class="program-tags">
                        ${nationalityTags}
                        ${educationTags}
                        ${pathTags}
                        ${tsukubaTag}
                    </div>
                </div>

                <p class="program-description">${program.description}</p>

                <div class="program-content">
                    <!-- 左カラム: 予算・書類 -->
                    <div class="program-left">
                        <h4 class="section-title">💰 支援内容 / Benefits</h4>
                        <div class="benefits-section">
                            ${benefitsHtml}
                        </div>

                        ${documentsHtml ? `
                        <h4 class="section-title">📄 必要書類 / Documents</h4>
                        <div class="documents-section">
                            ${documentsHtml}
                        </div>
                        ` : ''}
                    </div>

                    <!-- 右カラム: スケジュール -->
                    <div class="program-right">
                        <h4 class="section-title">📅 応募スケジュール / Schedule</h4>
                        <div class="schedule-section">
                            ${schedulesHtml}
                        </div>
                    </div>
                </div>

                <div class="program-links">
                    <a href="${program.url}" target="_blank" rel="noopener" class="program-link">
                        🔗 公式サイト / Official Site
                    </a>
                    ${relatedLinks}
                </div>
            </div>
        `;
    }

    // グローバルに公開（onclick用）
    window.toggleScheduleSelection = toggleScheduleSelection;

    /**
     * 支援内容フォーマット
     */
    function formatBenefits(benefits) {
        if (!benefits) return '<p>情報なし</p>';

        const rows = [];
        for (const [key, value] of Object.entries(benefits)) {
            rows.push(`
                <div class="benefit-row">
                    <span class="benefit-label">${key}</span>
                    <span class="benefit-value">${value}</span>
                </div>
            `);
        }
        return rows.join('');
    }

    /**
     * 必要書類フォーマット
     */
    function formatDocuments(documents) {
        if (!documents || documents.length === 0) return '';

        const items = documents.map(doc => `<li>${doc}</li>`).join('');
        return `<ul class="documents-list">${items}</ul>`;
    }

    /**
     * スケジュールがフィルターに一致するかチェック
     */
    function scheduleMatchesFilter(schedule, filterValue) {
        if (!filterValue) return true;

        const intake = schedule.intake || '';
        const adoptionPeriod = schedule.adoption_period || '';
        const adoptionDate = schedule.adoption_date || '';

        return matchesIntakeFilter(intake, filterValue) ||
               matchesIntakeFilter(adoptionPeriod, filterValue) ||
               matchesIntakeFilter(adoptionDate, filterValue);
    }

    /**
     * スケジュールフォーマット（アコーディオン + チェックボックス）
     */
    function formatSchedules(program, selectedIntake) {
        const schedules = program.application_schedule || [];
        if (schedules.length === 0) {
            return '<p>スケジュール情報なし</p>';
        }

        // 選択された入学時期でフィルタリング（元のインデックスは保持）
        const indexed = schedules.map((s, idx) => ({ s, idx }));
        const filtered = selectedIntake
            ? indexed.filter(({ s }) => scheduleMatchesFilter(s, selectedIntake))
            : indexed;

        if (filtered.length === 0) {
            return '<p class="no-schedule-match">選択した時期のスケジュールはありません</p>';
        }

        // スケジュール項目の定義（表示順）
        const scheduleFields = [
            { key: 'application_start', label: '募集開始', highlight: false },
            { key: 'web_registration', label: 'Web出願', highlight: false },
            { key: 'first_screening', label: '1次選考', highlight: false },
            { key: 'deadline', label: '締切', highlight: true },
            { key: 'document_deadline', label: '書類必着', highlight: true },
            { key: 'university_contact_deadline', label: '大学連絡期限', highlight: true },
            { key: 'second_screening', label: '2次選考', highlight: false },
            { key: 'document_screening', label: '書類審査', highlight: false },
            { key: 'university_recommendation', label: '大学推薦', highlight: false },
            { key: 'exam_date', label: '試験日', highlight: false },
            { key: 'interview', label: '面接', highlight: false },
            { key: 'first_result', label: '1次結果', highlight: false },
            { key: 'second_result', label: '2次結果', highlight: false },
            { key: 'result', label: '結果発表', highlight: false },
            { key: 'result_notification', label: '結果通知予定', highlight: false },
            { key: 'enrollment_procedure', label: '入学手続', highlight: false },
            { key: 'adoption_date', label: '採用日', highlight: false },
            { key: 'adoption_period', label: '採用開始', highlight: false },
            { key: 'arrival_date', label: '来日・採用開始', highlight: false },
            { key: 'internship_period', label: '実施期間', highlight: false }
        ];

        return filtered.map(({ s, idx }) => {
            const key = scheduleKey(program.id, idx);
            const isSelected = selectedSchedules.has(key);
            const checkedAttr = isSelected ? 'checked' : '';
            const selectedClass = isSelected ? 'selected' : '';
            const openAttr = isSelected ? 'open' : '';

            const details = [];
            scheduleFields.forEach(field => {
                if (s[field.key]) {
                    if (field.highlight) {
                        details.push(`<div><span class="schedule-label">${field.label}:</span> <span class="deadline-highlight">${s[field.key]}</span></div>`);
                    } else {
                        details.push(`<div><span class="schedule-label">${field.label}:</span> ${s[field.key]}</div>`);
                    }
                }
            });
            const hasDetails = details.length > 0;
            const detailsBody = hasDetails
                ? details.join('')
                : '<div class="schedule-empty">詳細日程未公開</div>';

            const intakeText = s.intake || '(intake 未設定)';
            const noteHtml = s.note ? `<div class="schedule-note">💡 ${s.note}</div>` : '';
            const expired = isScheduleExpired(s);
            const expiredClass = expired ? ' expired' : '';
            const expiredBadge = expired ? '<span class="schedule-expired-badge">募集終了</span>' : '';

            return `
                <div class="schedule-item ${selectedClass}${expiredClass}" id="schedule-${program.id}-${idx}">
                    <details ${openAttr}>
                        <summary class="schedule-summary">
                            <input type="checkbox" class="schedule-checkbox"
                                   ${checkedAttr}
                                   onclick="event.stopPropagation()"
                                   onchange="window.toggleScheduleSelection('${program.id}', ${idx}, this)"
                                   aria-label="このスケジュールをタイムライン比較に追加">
                            <span class="schedule-intake">🎓 ${intakeText}</span>
                            ${expiredBadge}
                        </summary>
                        <div class="schedule-details">
                            ${detailsBody}
                            ${noteHtml}
                        </div>
                    </details>
                </div>
            `;
        }).join('');
    }
});
