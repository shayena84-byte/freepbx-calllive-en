<?php

if (!defined('FREEPBX_IS_AUTH')) {
    http_response_code(403);
    exit;
}
if (!\FreePBX::Calllive()->canView()) {
    echo '<div class="alert alert-warning">Grant this user access to Call Monitor in FreePBX to view the dashboard.</div>';
    return;
}
?>
<div id="calllive" data-csrf="<?php echo htmlspecialchars(\FreePBX::Calllive()->csrfToken(), ENT_QUOTES, 'UTF-8'); ?>">
    <header class="cl-header">
        <div class="cl-overview">
            <div class="cl-heading">
                <div class="cl-kicker">FREEPBX · ASTERISK</div>
                <h1>Call Monitor</h1>
                <p>Live calls, trunk activity and extension states</p>
            </div>
            <div class="cl-daily">
                <p id="cl-daily-date">Today · PBX time</p>
                <dl>
                    <div><dt>Peak simultaneous calls</dt><dd id="cl-daily-peak">—</dd></div>
                    <div><dt>Longest conversation</dt><dd id="cl-daily-longest">—</dd></div>
                </dl>
            </div>
            <div class="cl-health">
                <span id="cl-status" class="cl-badge" data-tone="neutral" role="status">Connecting…</span>
                <span id="cl-updated"></span>
            </div>
        </div>
        <nav class="cl-tabs" aria-label="Call Monitor sections">
            <button type="button" data-cl-view="monitor" aria-controls="cl-view-monitor" aria-pressed="true">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 12h4l3-7 5 14 3-7h5"/></svg>
                Live
            </button>
            <button type="button" data-cl-view="history" aria-controls="cl-view-history" aria-pressed="false">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>
                History
            </button>
            <button type="button" data-cl-view="statistics" aria-controls="cl-view-statistics" aria-pressed="false">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 4v16h16M8 15v-4m4 4V8m4 7V5"/></svg>
                Statistics
            </button>
            <button type="button" data-cl-view="diagnostics" aria-controls="cl-view-diagnostics" aria-pressed="false">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="4" width="14" height="16" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></svg>
                Diagnostics
            </button>
        </nav>
    </header>

    <p id="cl-notice" class="cl-notice" hidden></p>
    <noscript><p class="cl-notice">Enable JavaScript to refresh the dashboard.</p></noscript>

    <div id="cl-view-monitor">
    <dl class="cl-metrics">
        <div>
            <dt><span class="cl-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M2 12h4l3-7 5 14 3-7h5"/></svg></span><span>Active connections</span></dt>
            <dd id="cl-count-connections">—</dd>
        </div>
        <div>
            <dt><span class="cl-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M12 7v4M5 16v-5h14v5"/><rect x="9" y="2" width="6" height="5" rx="1"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/></svg></span><span>Trunks in use</span></dt>
            <dd id="cl-count-trunks">—</dd>
        </div>
        <div>
            <dt><span class="cl-metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5v1"/></svg></span><span>Active extensions</span></dt>
            <dd id="cl-count-extensions">—</dd>
        </div>
    </dl>

    <section class="cl-section" aria-labelledby="cl-calls-title">
        <div class="cl-section-title">
            <h2 id="cl-calls-title" tabindex="-1">Live calls</h2>
            <label class="cl-search">Show
                <select id="cl-problem-filter"><option value="all">All calls</option><option value="problems">Calls with alerts</option>
                    <option value="quality">Low quality</option><option value="loss">Packet loss</option><option value="wait">Long wait</option></select>
            </label>
        </div>
        <p id="cl-alerts" class="cl-alerts" role="status" hidden></p>
        <div class="cl-table-wrap">
            <table class="cl-table cl-calls-table">
                <thead><tr><th scope="col">Status</th><th scope="col">Participants and channels</th><th scope="col">Trunks</th><th scope="col">Quality</th><th scope="col" class="cl-call-age">Elapsed</th></tr></thead>
                <tbody id="cl-calls"><tr><td colspan="5">Waiting for data…</td></tr></tbody>
            </table>
        </div>
    </section>

    <div class="cl-columns">
        <section class="cl-section" aria-labelledby="cl-trunks-title">
            <div class="cl-section-title">
                <h2 id="cl-trunks-title" tabindex="-1">Trunks</h2>
                <span>Select a trunk to view details</span>
            </div>
            <div class="cl-table-wrap">
                <table class="cl-table">
                    <thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Channels</th></tr></thead>
                    <tbody id="cl-trunks"><tr><td colspan="3">Waiting for data…</td></tr></tbody>
                </table>
            </div>
        </section>

        <section class="cl-section" aria-labelledby="cl-extensions-title">
            <div class="cl-section-title">
                <h2 id="cl-extensions-title" tabindex="-1">Extensions</h2>
                <label class="cl-search"><span class="sr-only">Find an extension or name</span>
                    <input id="cl-search" type="search" placeholder="Extension or name" autocomplete="off">
                </label>
            </div>
            <div class="cl-table-wrap">
                <table class="cl-table">
                    <thead><tr><th scope="col">Extension / name</th><th scope="col">State</th><th scope="col">Channels</th></tr></thead>
                    <tbody id="cl-extensions"><tr><td colspan="3">Waiting for data…</td></tr></tbody>
                </table>
            </div>
        </section>
    </div>
    <p class="cl-footnote">Off hook appears when the PBX receives an OffHook indication. An IP phone may show Idle until it sends a SIP signal.</p>
    </div>
    <section id="cl-view-history" class="cl-section" hidden aria-labelledby="cl-history-title">
        <div class="cl-section-title"><h2 id="cl-history-title" tabindex="-1">Call history</h2></div>
        <form id="cl-history-form" class="cl-toolbar">
            <label>From <input id="cl-history-from" type="date" required></label>
            <label>To <input id="cl-history-to" type="date" required></label>
            <label>Number or channel <input id="cl-history-search" type="search" maxlength="100" placeholder="201, +1202…, PJSIP/carrier"></label>
            <label><input id="cl-history-problem" type="checkbox"> Low quality only</label>
            <button class="cl-detail-link" type="submit">Search</button>
        </form>
        <p id="cl-history-status" class="cl-view-note" role="status">History is recorded while the collector runs. Search dates use PBX time. Event times use the browser time zone.</p>
        <div class="cl-table-wrap"><table class="cl-table">
            <thead><tr><th>Start / end</th><th>Participants / channels</th><th>Talk time / total time</th><th>Latest / worst quality</th><th>Result</th></tr></thead>
            <tbody id="cl-history"></tbody>
        </table></div>
        <button id="cl-history-more" type="button" class="cl-detail-link cl-more" hidden>Load more</button>
    </section>

    <section id="cl-view-statistics" class="cl-section" hidden aria-labelledby="cl-statistics-title">
        <div class="cl-section-title"><h2 id="cl-statistics-title">Call statistics</h2></div>
        <form id="cl-statistics-form" class="cl-toolbar">
            <label>From <input id="cl-statistics-from" type="date" required></label>
            <label>To <input id="cl-statistics-to" type="date" required></label>
            <button class="cl-detail-link" type="submit">Show</button>
        </form>
        <p id="cl-statistics-status" class="cl-view-note" role="status"></p>
        <div id="cl-load-chart" class="cl-stat-chart"></div>
        <div class="cl-table-wrap"><table class="cl-table">
            <thead><tr><th>Date</th><th>Completed / answered</th><th>Peak calls</th><th>Longest conversation</th><th>Observed time</th></tr></thead>
            <tbody id="cl-statistics"></tbody>
        </table></div>
        <h3 class="cl-view-note">Hourly activity for the selected day</h3>
        <label class="cl-search cl-view-note">Day <select id="cl-stat-day"></select></label>
        <div id="cl-hour-chart" class="cl-stat-chart"></div>
        <h3 class="cl-view-note">Peak simultaneous channels per trunk</h3>
        <div class="cl-table-wrap"><table class="cl-table"><thead><tr><th>Trunk</th><th>Peak channels in period</th></tr></thead><tbody id="cl-trunk-peaks"></tbody></table></div>
        <p class="cl-view-note">Call counts include completed calls observed by the collector, grouped by start date. Peaks cover the observed period. Hours without observations are marked separately.</p>
    </section>

    <section id="cl-view-diagnostics" class="cl-section" hidden aria-labelledby="cl-diagnostics-title">
        <div class="cl-section-title"><h2 id="cl-diagnostics-title">Diagnostics and updates</h2>
            <button id="cl-diagnostics-refresh" type="button" class="cl-detail-link">Check again</button></div>
        <p id="cl-diagnostics-status" class="cl-view-note" role="status"></p>
        <div id="cl-diagnostics-fields" class="cl-view-note"></div>
        <div id="cl-update" class="cl-update" hidden>
            <h3>Collector setup</h3>
            <p>Install the module archive in Module Admin, apply its local signature and select Apply Config. Run the command below as root for first-time collector setup or when upgrading an older collector.</p>
            <label class="sr-only" for="cl-update-command">Collector setup command</label>
            <textarea id="cl-update-command" rows="2" readonly spellcheck="false"></textarea>
            <button id="cl-copy-update" type="button" class="cl-detail-link">Copy command</button>
            <p class="cl-detail-note">The command checks Python and AMI, creates a backup, updates the collector and checks for a fresh snapshot. It restores the previous files if the update fails.</p>
            <p><a href="https://github.com/shayena84-byte/freepbx-calllive-en/tree/main/dist/15.0.10" target="_blank" rel="noopener noreferrer">Open the installation package</a></p>
            <h3>Alert thresholds</h3>
            <form id="cl-threshold-form" class="cl-toolbar">
                <label>Quality below (%) <input id="cl-setting-quality" type="number" min="0" max="100" step="1" required></label>
                <label>Loss above (%) <input id="cl-setting-loss" type="number" min="0.1" max="100" step="0.1" required></label>
                <label>Wait longer than (s) <input id="cl-setting-wait" type="number" min="5" max="3600" required></label>
                <label>Issue persists for (s) <input id="cl-setting-sustain" type="number" min="0" max="300" required></label>
                <button type="submit" class="cl-detail-link">Save</button>
            </form>
            <p id="cl-settings-status" class="cl-detail-note" role="status"></p>
        </div>
        <p class="cl-view-note">Alerts appear while the dashboard is open. Administrators with full access can set thresholds for all users.</p>
    </section>

    <dialog id="cl-detail" class="cl-detail cl-call-dialog" aria-labelledby="cl-detail-title">
        <div class="cl-section-title">
            <h2 id="cl-detail-title">Technical call details</h2>
            <form method="dialog">
                <button type="submit" class="cl-detail-close" autofocus>Close</button>
            </form>
        </div>
        <div class="cl-detail-summary">
            <span id="cl-detail-state" role="status"></span>
            <span id="cl-detail-age" class="cl-time"></span>
            <span id="cl-detail-quality"></span>
        </div>
        <section id="cl-insights" class="cl-insights" hidden>
            <p id="cl-record-summary" class="cl-detail-note"></p>
            <div id="cl-record-review" class="cl-record-review" hidden>
                <section class="cl-route-panel" aria-labelledby="cl-timeline-title">
                    <h3 id="cl-timeline-title" tabindex="-1">Call timeline</h3>
                    <p class="cl-detail-note">Asterisk events in the order observed.</p>
                    <ol id="cl-timeline" class="cl-timeline"></ol>
                </section>
                <section class="cl-quality-panel" aria-labelledby="cl-chart-title">
                    <h3 id="cl-chart-title" tabindex="-1">Quality charts</h3>
                    <div class="cl-chart-controls">
                        <label class="cl-search">Channel <select id="cl-chart-channel"><option value="">Worst measurements across all channels</option></select></label>
                        <button type="button" id="cl-clear-marker" class="cl-detail-link" hidden>Clear marker</button>
                    </div>
                    <p id="cl-chart-selection" class="cl-chart-selection" role="status" hidden></p>
                    <div id="cl-quality-charts" class="cl-chart-grid"></div>
                    <p id="cl-chart-note" class="cl-detail-note"></p>
                </section>
            </div>
            <h3>How the quality score is calculated</h3>
            <div id="cl-quality-explanation"></div>
            <p id="cl-record-notice" class="cl-detail-note" role="status"></p>
        </section>
        <div id="cl-detail-legs" class="cl-detail-legs"></div>
    </dialog>

    <dialog id="cl-entity" class="cl-detail" aria-labelledby="cl-entity-title">
        <div class="cl-section-title">
            <h2 id="cl-entity-title">Details</h2>
            <form method="dialog">
                <button type="submit" class="cl-detail-close" autofocus>Close</button>
            </form>
        </div>
        <div class="cl-detail-summary">
            <span id="cl-entity-live"></span>
            <span id="cl-entity-status" role="status"></span>
        </div>
        <div id="cl-entity-legs" class="cl-detail-legs"></div>
    </dialog>


</div>
