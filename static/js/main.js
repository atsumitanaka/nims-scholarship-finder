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

    // 選択されたプログラムを保持
    let selectedPrograms = new Map();
    let allPrograms = [];

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
     * 年テキスト + 月セレクトを内部フィルタ値に変換
     *   - 年も月も空: ''
     *   - 年だけ:    'YYYY-any'
     *   - 月だけ:    'any-MM' / 'any-first' / 'any-second'
     *   - 両方:      'YYYY-MM' / 'YYYY-first' / 'YYYY-second'
     */
    function getIntakeFilterValue() {
        const yearRaw = (intakeYearInput.value || '').trim();
        const month = intakeMonthPartSelect.value;
        const yearValid = /^\d{4}$/.test(yearRaw);
        if (!yearValid && !month) return '';
        if (!yearValid && month) return `any-${month}`;
        if (yearValid && !month) return `${yearRaw}-any`;
        return `${yearRaw}-${month}`;
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
            /(\d{4})年(\d{1,2})月(\d{1,2})日/,
            /(\d{4})年(\d{1,2})月/,
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

    /**
     * 締切超過のスケジュールを除外
     */
    function filterExpiredSchedules(schedules) {
        return (schedules || []).filter(s => !isDeadlinePassed(s.deadline || ''));
    }

    /**
     * プログラムの最も近い締切日を取得（ソート用）
     */
    function getNearestDeadline(program) {
        const schedules = program.application_schedule || [];
        if (schedules.length === 0) return FAR_FUTURE;
        let nearest = FAR_FUTURE;
        for (const s of schedules) {
            const d = parseDeadline(s.deadline || '');
            if (d < nearest) nearest = d;
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
            const activeSchedules = filterExpiredSchedules(original.application_schedule);
            if (activeSchedules.length === 0) continue;

            const program = { ...original, application_schedule: activeSchedules };

            if (nationality && !(program.target_nationality || []).includes(nationality)) continue;
            if (current_education && !(program.current_education || []).includes(current_education)) continue;
            if (desired_path && !(program.desired_path || []).includes(desired_path)) continue;

            if (intake_month) {
                const hasMatch = activeSchedules.some(s => {
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

        results.sort((a, b) => getNearestDeadline(a) - getNearestDeadline(b));
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
        selectedPrograms.clear();
        document.querySelectorAll('.program-card.selected').forEach(card => {
            card.classList.remove('selected');
        });
        document.querySelectorAll('.program-checkbox').forEach(checkbox => {
            checkbox.checked = false;
        });
        updateTimeline();
    }

    /**
     * 選択状態を復元
     */
    function restoreSelections() {
        selectedPrograms.forEach((program, id) => {
            const checkbox = document.getElementById(`checkbox-${id}`);
            const card = document.getElementById(`card-${id}`);
            if (checkbox) checkbox.checked = true;
            if (card) card.classList.add('selected');
        });
    }

    /**
     * プログラム選択のトグル
     */
    function toggleProgramSelection(programId, checkbox) {
        const program = allPrograms.find(p => p.id === programId);
        const card = document.getElementById(`card-${programId}`);

        if (checkbox.checked) {
            selectedPrograms.set(programId, program);
            if (card) card.classList.add('selected');
        } else {
            selectedPrograms.delete(programId);
            if (card) card.classList.remove('selected');
        }

        updateTimeline();
    }

    /**
     * タイムライン更新
     */
    function updateTimeline() {
        const mainContent = document.querySelector('.main-content');

        if (selectedPrograms.size === 0) {
            timelineSection.style.display = 'none';
            if (mainContent) mainContent.classList.remove('has-timeline');
            return;
        }

        timelineSection.style.display = 'block';
        if (mainContent) mainContent.classList.add('has-timeline');

        const selectedIntake = getIntakeFilterValue();
        const events = collectTimelineEvents(selectedIntake);
        renderTimeline(events, selectedIntake);
    }

    /**
     * 入学時期がフィルターに一致するかチェック。
     * filterValue は getIntakeFilterValue() の出力形式：
     *   - ''                : フィルターなし
     *   - 'YYYY-any'        : 年だけ指定（月は問わない）
     *   - 'any-MM'/'any-first'/'any-second' : 月だけ指定（年は問わない）
     *   - 'YYYY-04'/'YYYY-10' / 'YYYY-first'/'YYYY-second' : 両方指定
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

        const isAnyMonth = targetType === "any";
        const isFirstHalf = targetType === "first";
        const isSecondHalf = targetType === "second";
        const isSpecificMonth = targetType === "04" || targetType === "10";
        const targetMonth = isSpecificMonth ? parseInt(targetType) : null;

        // 随時は常に表示
        if (intakeStr.includes('随時')) return true;

        const matchesYear = (y) => isAnyYear || y === targetYear;

        // 年度形式 "2026年度"（月不明）
        const fiscalYearMatch = intakeStr.match(/(\d{4})年度/);
        if (fiscalYearMatch && matchesYear(parseInt(fiscalYearMatch[1]))) {
            // 月不明な intake は「年だけ指定」または「両方指定」時にのみ通す
            // 「月だけ指定」のときは年度表記だけでは月が分からないので通さない
            if (!isAnyYear) return true;  // 年指定あり → 年度一致で OK
            // isAnyYear のときはここでは判定保留（後段で月情報を探す）
        }

        // 範囲表記 "2026年4月1日〜9月30日開始"
        const periodMatch = intakeStr.match(/(\d{4})年(\d{1,2})月.*?[〜~～].*?(\d{1,2})月/);
        if (periodMatch) {
            const periodYear = parseInt(periodMatch[1]);
            const startMonth = parseInt(periodMatch[2]);
            const endMonth = parseInt(periodMatch[3]);
            if (matchesYear(periodYear)) {
                if (isAnyMonth) return true;
                if (isFirstHalf && startMonth <= 9) return true;
                if (isSecondHalf && (startMonth >= 10 || endMonth >= 10)) return true;
                if (isSpecificMonth && startMonth <= targetMonth && targetMonth <= endMonth) return true;
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
            if (isAnyMonth) return true;
            if (isSpecificMonth && month === targetMonth) return true;
            if (isFirstHalf && month >= 4 && month <= 9) return true;
            if (isSecondHalf && (month >= 10 || month <= 3)) return true;
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
    function collectTimelineEvents(selectedIntake) {
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
            { key: 'enrollment_procedure', type: 'procedure', label: '入学手続' },
            { key: 'adoption_date', type: 'adoption', label: '採用日' },
            { key: 'adoption_period', type: 'adoption', label: '採用開始時期' },
            { key: 'internship_period', type: 'period', label: 'インターン期間' }
        ];

        selectedPrograms.forEach((program, id) => {
            const schedules = program.application_schedule || [];

            schedules.forEach(schedule => {
                // 入学希望時期でフィルタリング
                if (!matchesIntakeFilter(schedule.intake, selectedIntake)) {
                    return;
                }

                // 各イベントタイプをチェック
                eventTypes.forEach(eventType => {
                    if (schedule[eventType.key]) {
                        events.push({
                            program: program.name,
                            programId: id,
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

        // 年月日パターン
        const patterns = [
            /(\d{4})年(\d{1,2})月(\d{1,2})日/,
            /(\d{4})年(\d{1,2})月/,
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
    function renderTimeline(events, selectedIntake) {
        if (events.length === 0) {
            const message = selectedIntake
                ? '選択した入学時期に該当するスケジュールがありません。<br>入学希望時期を変更するか、別の制度を選択してください。'
                : 'スケジュール情報がありません。';
            timelineContainer.innerHTML = `<p class="no-results">${message}</p>`;
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

        // フィルタ情報
        const filterInfo = selectedIntake
            ? `<div class="timeline-filter-info">📅 ${formatIntakeMonth(selectedIntake)} 入学向けスケジュール</div>`
            : '';

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
        const yearLabelForFiscal = isAnyYear ? '任意の年度' : `${year}年度`;

        if (type === 'any') {
            return yearLabel;
        } else if (type === 'first') {
            return `${yearLabelForFiscal}前期（4-9月）`;
        } else if (type === 'second') {
            return `${yearLabelForFiscal}後期（10-3月）`;
        } else if (type === '04') {
            return `${yearLabel}4月`;
        } else if (type === '10') {
            return `${yearLabel}10月`;
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
        const schedulesHtml = formatSchedules(program.application_schedule, selectedIntake);

        // 関連リンク
        const relatedLinks = (program.related_urls || []).map(link =>
            `<a href="${link.url}" target="_blank" rel="noopener" class="program-link program-link-secondary">${link.label}</a>`
        ).join('');

        // チェックボックスの状態
        const isChecked = selectedPrograms.has(program.id) ? 'checked' : '';
        const isSelected = selectedPrograms.has(program.id) ? 'selected' : '';

        return `
            <div class="program-card ${isSelected}" id="card-${program.id}">
                <div class="program-checkbox-wrapper">
                    <input type="checkbox" class="program-checkbox" id="checkbox-${program.id}"
                           data-program-id="${program.id}" ${isChecked}
                           onchange="window.toggleProgramSelection('${program.id}', this)">
                    <label for="checkbox-${program.id}" class="program-checkbox-label">
                        スケジュール比較に追加 / Add to timeline
                    </label>
                </div>
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
    window.toggleProgramSelection = toggleProgramSelection;

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
     * スケジュールフォーマット
     */
    function formatSchedules(schedules, selectedIntake) {
        if (!schedules || schedules.length === 0) {
            return '<p>スケジュール情報なし</p>';
        }

        // 選択された入学時期でフィルタリング
        const filteredSchedules = selectedIntake
            ? schedules.filter(s => scheduleMatchesFilter(s, selectedIntake))
            : schedules;

        if (filteredSchedules.length === 0) {
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
            { key: 'enrollment_procedure', label: '入学手続', highlight: false },
            { key: 'adoption_date', label: '採用日', highlight: false },
            { key: 'adoption_period', label: '採用開始', highlight: false },
            { key: 'internship_period', label: '実施期間', highlight: false }
        ];

        return filteredSchedules.map(s => {
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

            return `
                <div class="schedule-item">
                    <div class="schedule-intake">🎓 ${s.intake}</div>
                    <div class="schedule-details">
                        ${details.join('')}
                    </div>
                    ${s.note ? `<div class="schedule-note">💡 ${s.note}</div>` : ''}
                </div>
            `;
        }).join('');
    }
});
