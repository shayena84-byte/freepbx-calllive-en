(() => {
    'use strict';

    const root = document.getElementById('calllive');
    if (!root) return;

    const byId = (id) => document.getElementById(id);
    const unknown = '—';
    const connectedPhases = new Set(['connected', 'held', 'conference']);
    const detailDialog = byId('cl-detail');
    const entityDialog = byId('cl-entity');
    const detailNumber = new Intl.NumberFormat('en-GB', {maximumFractionDigits: 2});
    const callButtons = new Map();
    const entityButtons = new Map();
    const phases = {
        connected: ['Connected', 'ok'],
        held: ['On hold', 'wait'],
        conference: ['Group call', 'ok'],
        ringing: ['Ringing', 'wait'],
        queue: ['Queued', 'wait'],
        parked: ['Parked', 'wait'],
        waiting: ['Waiting', 'wait'],
        service: ['PBX service', 'neutral'],
        setup: ['Setting up', 'neutral'],
    };

    const health = {
        ready: ['Connected to PBX', 'ok', ''],
        ami_offline: ['AMI unavailable', 'danger', 'Check the local Asterisk AMI port and the freepbx-calllive service log.'],
        ami_auth: ['AMI login failed', 'danger', 'Check the dedicated AMI account name, secret and ACL.'],
        ami_action: ['AMI rejected the request', 'danger', 'Check the CoreShowChannels, BridgeList and ExtensionStateList permissions and review the service log.'],
        snapshot_limit: ['Snapshot too large', 'danger', 'The snapshot exceeded the dashboard size limit. See the service log for details.'],
        collector_unavailable: ['No data from the collector', 'danger', 'Check the freepbx-calllive service and make sure FreePBX can read its snapshot.'],
        request_error: ['Connection to FreePBX lost', 'danger', 'The dashboard will retry automatically.'],
        access_denied: ['Access ended', 'danger', 'Sign in to FreePBX with access to Call Monitor, then refresh this page.'],
    };

    let inventory = null;
    let inventoryChecked = 0;
    let inventoryError = false;
    let snapshot = null;
    let receivedAt = 0;
    let extensions = [];
    let selectedCall = '';
    let detailSignature = '';
    let lastCall = null;
    let selectedEntity = null;
    let entityTimer = null;
    let entityRequest = null;
    let currentView = 'monitor';
    let thresholds = {quality: 65, loss: 2, wait: 30, sustain: 10};
    let problems = new Map();
    let recordSelection = null;
    let recordTimer = null;
    let recordRequest = null;
    let shownRecord = null;
    let selectedEvent = null;
    let historyCursor = null;
    let historyRecords = [];
    let historyGeneration = 0;
    let statisticsData = {};
    let diagnosis = null;
    let accessEpoch = 0;
    let pbxDatesInitialized = false;

    function node(tag, value = '', className = '') {
        const element = document.createElement(tag);
        element.textContent = value;
        if (className) element.className = className;
        return element;
    }

    function badge(text, tone) {
        const element = node('span', text, 'cl-badge');
        element.dataset.tone = tone;
        return element;
    }

    function cell(row, value, className = '') {
        const element = node('td', typeof value === 'string' ? value : '', className);
        if (typeof value !== 'string') element.appendChild(value);
        row.appendChild(element);
    }

    function table(id, rows, width, emptyText) {
        const body = byId(id);
        const content = document.createDocumentFragment();
        if (rows.length) {
            rows.forEach((row) => content.appendChild(row));
        } else {
            const row = node('tr');
            const message = node('td', emptyText, 'cl-empty');
            message.colSpan = width;
            row.appendChild(message);
            content.appendChild(row);
        }
        body.textContent = '';
        body.appendChild(content);
    }

    function techName(tech) {
        const value = String(tech).toUpperCase();
        if (value === 'ZAP') return 'DAHDI';
        return value === 'IAX' ? 'IAX2' : value;
    }

    function dialKey(dial) {
        const match = String(dial).match(/^(PJSIP|SIP|IAX2|DAHDI|ZAP)\/([^/@\s,;&]+)(?:\/.*)?$/i);
        if (!match) return '';
        const tech = techName(match[1]);
        if (tech === 'DAHDI' && !/^\d+$/.test(match[2])) return '';
        return tech + '/' + match[2];
    }

    function channelKey(name) {
        const match = name.match(/^([^/]+)\/([^/]+)-[0-9a-f]+$/i);
        return match ? dialKey(match[1] + '/' + match[2]) : '';
    }

    function index(map, key, value) {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(value);
    }

    function buildLookups(data, hints) {
        const numbers = new Map(data.extensions.map((item) => [String(item.extension), item]));
        const states = new Map();
        const hintDevices = new Map();
        const fixedDevices = new Map();
        const trunks = new Map();
        for (const hint of hints) {
            if (!numbers.has(hint.ext)) continue;
            states.set(hint.ext, hint.status);
            for (const dial of hint.hint.split(',', 1)[0].split('&')) {
                index(hintDevices, dialKey(dial.trim()), hint.ext);
            }
        }
        for (const device of data.devices) {
            if (!numbers.has(String(device.user)) || device.devicetype === 'adhoc') continue;
            const tech = techName(device.tech);
            const key = dialKey(device.dial) || (tech === 'DAHDI' ? '' : dialKey(tech + '/' + device.id));
            index(fixedDevices, key, String(device.user));
        }
        for (const trunk of data.trunks) index(trunks, dialKey(techName(trunk.tech) + '/' + trunk.channelid), trunk);
        return {numbers, states, hintDevices, fixedDevices, trunks};
    }

    function assign(channel, lookup) {
        const key = channelKey(channel.name);
        const phones = lookup.hintDevices.get(key) || lookup.fixedDevices.get(key) || new Set();
        const providers = lookup.trunks.get(key) || new Set();
        if (phones.size === 1 && !providers.size) {
            return {channel, extension: lookup.numbers.get(phones.values().next().value)};
        }
        if (providers.size === 1 && !phones.size) {
            return {channel, trunk: providers.values().next().value, key};
        }
        return {channel, ambiguous: phones.size + providers.size > 1};
    }

    function formatNumber(value) {
        return value && !/^<?(?:unknown|none|unspecified|null)>?$/i.test(value) ? value : '';
    }

    function participant(item) {
        const {channel, extension, trunk} = item;
        const element = node('span', '', 'cl-participant');
        element.title = channel.name;
        let label;
        let detail;

        if (extension) {
            label = [String(extension.extension), extension.name].filter(Boolean).join(' · ');
        } else if (trunk) {
            const caller = formatNumber(channel.caller);
            const connected = formatNumber(channel.connected);
            const endpoint = item.key.split('/')[1];
            const dialed = channel.dialed === endpoint ? '' : channel.dialed;
            if (channel.direction === 'in') {
                label = caller || 'Inbound channel';
                detail = [formatNumber(channel.caller_name), 'Inbound'].filter((value) => value && value !== label).join(' · ');
            } else if (channel.direction === 'out') {
                label = dialed || (connected !== caller ? connected : '') || 'Outbound channel';
                detail = 'Outbound';
            } else {
                label = 'External channel';
                detail = [caller && 'Caller ID ' + caller, connected && connected !== caller && 'Connected Line ' + connected]
                    .filter(Boolean).join(' · ');
            }
        } else {
            label = formatNumber(channel.caller) || formatNumber(channel.caller_name) || channel.name;
            detail = item.ambiguous ? 'Multiple possible matches' : '';
        }
        element.appendChild(node('strong', label));
        const technical = [detail, channel.name].filter((value) => value && value !== label).join(' · ');
        if (technical) element.appendChild(node('small', technical));
        return element;
    }

    function trunkName(trunk) {
        return trunk.name || techName(trunk.tech) + '/' + trunk.channelid;
    }

    function formatDuration(seconds) {
        if (!Number.isFinite(seconds)) return unknown;
        const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
        return parts.map((part) => String(part).padStart(2, '0')).join(':');
    }

    function duration(seconds) {
        return Number.isFinite(seconds) ? formatDuration(seconds + Math.floor((performance.now() - receivedAt) / 1000)) : unknown;
    }

    function timeLabel(timestamp) {
        return new Date(timestamp * 1000).toLocaleTimeString('en-GB');
    }

    function callKey(group) {
        return group.call_id || JSON.stringify(group.channels);
    }

    function detailFields(fields) {
        const list = node('dl', '', 'cl-detail-fields');
        for (const [label, value] of fields) {
            const entry = node('div');
            entry.appendChild(node('dt', label));
            entry.appendChild(node('dd', value || unknown));
            list.appendChild(entry);
        }
        return list;
    }

    function measure(value, unit = '') {
        return Number.isFinite(value) ? detailNumber.format(value) + unit : unknown;
    }

    function packetLoss(lost, total) {
        if (!Number.isInteger(lost) || !Number.isInteger(total) || total < 20 || lost < 0 || lost > total) {
            return null;
        }
        return lost * 100 / total;
    }

    function timing(value) {
        return Number.isFinite(value) && value >= 0 ? value : null;
    }

    function qualityFactor(value, good, poor) {
        if (value === null) return 1;
        return 1 - Math.min(1, Math.max(0, (value - good) / (poor - good)));
    }

    function channelQuality(rtp) {
        if (!rtp || (rtp.sampled_at && snapshot && snapshot.updated_at - rtp.sampled_at > 15)) return null;
        const inbound = Number.isInteger(rtp.rx_packets) && rtp.rx_packets >= 0
            ? packetLoss(rtp.rx_lost, rtp.rx_packets + rtp.rx_lost) : null;
        const outbound = packetLoss(rtp.tx_lost, rtp.tx_packets);
        const losses = [inbound, outbound].filter((value) => value !== null);
        const jitter = timing(rtp.rx_jitter_ms);
        const rtt = timing(rtp.rtt_ms);
        if (!losses.length || (jitter === null && rtt === null)) return null;

        // Loss is a percentage. Jitter and round-trip time are in milliseconds.
        const loss = Math.max(...losses);
        const score = 100 * qualityFactor(loss, 0.1, 10) * qualityFactor(jitter, 20, 100)
            * qualityFactor(rtt, 150, 800);
        return {score: Math.round(score), partial: losses.length < 2 || jitter === null || rtt === null,
            loss, jitter, rtt, factors: {loss: qualityFactor(loss, 0.1, 10),
                jitter: qualityFactor(jitter, 20, 100), rtt: qualityFactor(rtt, 150, 800)}};
    }

    function callQuality(people, channelCount) {
        let score = null;
        let partial = people.length < channelCount;
        for (const {channel} of people) {
            const quality = channelQuality(channel.rtp);
            if (!quality) {
                partial = true;
                continue;
            }
            score = score === null ? quality.score : Math.min(score, quality.score);
            partial = partial || quality.partial;
        }
        return score === null ? null : {score, partial};
    }

    function qualityBadge(quality, missing = 'Insufficient RTP/RTCP measurements') {
        const element = node('span', '', 'cl-quality');
        if (!quality) {
            element.appendChild(badge(unknown, 'neutral'));
            element.title = missing;
            return element;
        }
        const {score, partial} = quality;
        const tone = score >= 85 ? 'ok' : score >= 65 ? 'wait' : 'danger';
        element.appendChild(badge(score + '%', tone));
        element.title = 'Score from the lowest-scoring measured channel';
        if (partial) {
            element.title += '. Some measurements are unavailable';
            element.appendChild(node('small', 'partial', 'cl-quality-note'));
        }
        return element;
    }

    function channelDetails(item) {
        const {channel, extension, trunk} = item;
        const leg = node('article', '', 'cl-detail-leg');
        const direction = {in: 'Inbound', out: 'Outbound'}[channel.direction];
        const label = extension ? [extension.extension, extension.name].filter(Boolean).join(' · ')
            : trunk ? ['Trunk ' + trunkName(trunk), direction].filter(Boolean).join(' · ')
                : 'Channel ' + channel.name.split('/')[0];
        leg.appendChild(node('h3', label));
        leg.appendChild(node('p', channel.name, 'cl-detail-channel'));
        const location = [channel.exten, channel.context].filter(Boolean).join(' @ ');
        leg.appendChild(detailFields([
            ['Channel state', channel.held ? 'On hold' : channel.state],
            ['Caller ID / Connected Line', [formatNumber(channel.caller) || unknown,
                formatNumber(channel.connected) || unknown].join(' / ')],
            ['Dialplan location', location],
            ['Asterisk application', channel.app],
            ['Uniqueid', channel.id],
            ['Linkedid', channel.linked],
            ['Asterisk bridge', [channel.bridge_type, channel.bridge].filter(Boolean).join(' · ')],
        ]));

        leg.appendChild(node('h4', 'Audio channel quality'));
        const codecs = channel.codecs || {};
        const rtp = channel.rtp || {};
        leg.appendChild(detailFields([
            ['Native codecs', codecs.native],
            ['PBX read / write format', [codecs.read || unknown, codecs.write || unknown].join(' / ')],
            ['RTP packets received / sent', measure(rtp.rx_packets) + ' / ' + measure(rtp.tx_packets)],
            ['Receive jitter at the PBX', measure(rtp.rx_jitter_ms, ' ms')],
            ['Receive loss at the PBX', measure(rtp.rx_lost, ' packets')],
            ['Remote-reported packet loss', measure(rtp.tx_lost, ' packets')],
            ['RTCP round-trip time', measure(rtp.rtt_ms, ' ms')],
        ]));
        let note = 'RTP/RTCP metrics appear when Asterisk provides them. Direct media can make measurements unavailable at the PBX.';
        if (!/^(PJSIP|SIP)\//i.test(channel.name)) {
            note = 'RTP/RTCP measurements are available for SIP and PJSIP audio channels.';
        } else if (rtp.sampled_at) {
            const time = new Date(rtp.sampled_at * 1000).toLocaleTimeString('en-GB');
            note = 'RTP/RTCP sample at ' + time + '. A dash indicates an unavailable measurement.';
        }
        leg.appendChild(node('p', note, 'cl-detail-note'));
        return leg;
    }

    function renderCallDetail(data, assigned) {
        if (!selectedCall || (recordSelection && recordSelection.archived)) return;
        const available = data.state === 'ready';
        const group = available && data.groups.find((item) =>
            callKey(item) === selectedCall);
        const stateNode = byId('cl-detail-state');
        const age = byId('cl-detail-age');
        const quality = byId('cl-detail-quality');
        if (data.state === 'access_denied') {
            lastCall = null;
            detailSignature = '';
            byId('cl-detail-legs').textContent = '';
            age.textContent = '';
            quality.textContent = '';
            stateNode.textContent = 'Access ended.';
            return;
        }
        if (!group) {
            const sameParticipants = available && lastCall && data.channels.some((channel) => lastCall.ids.has(channel.id));
            const status = available ? (sameParticipants ? 'The call participants changed.' : 'Call ended.')
                : 'Call data is temporarily unavailable.';
            if (stateNode.textContent !== status) stateNode.textContent = status;
            age.textContent = lastCall ? lastCall.age + ' · last snapshot ' + timeLabel(lastCall.at) : '';
            return;
        }
        const state = phases[group.phase][0];
        if (stateNode.textContent !== state) stateNode.textContent = state;
        lastCall = {ids: new Set(group.channels), age: 'Call elapsed ' + duration(group.age), at: data.updated_at};
        age.textContent = lastCall.age;
        const people = group.channels.map((id) => assigned.get(id)).filter(Boolean);
        const signature = JSON.stringify(people);
        if (signature === detailSignature) return;
        detailSignature = signature;
        quality.textContent = 'Quality ';
        quality.appendChild(qualityBadge(callQuality(people, group.channels.length)));
        const legs = byId('cl-detail-legs');
        legs.textContent = '';
        people.forEach((person) => legs.appendChild(channelDetails(person)));
    }

    function callRows(data, assigned) {
        const rows = [];
        for (const group of data.groups) {
            const people = group.channels.map((id) => assigned.get(id)).filter(Boolean);
            if (!people.length) continue;
            const foundProblems = problems.get(callKey(group)) || [];
            const activeProblems = foundProblems.filter((problem) => problem.active);
            const filter = byId('cl-problem-filter').value || 'all';
            if (filter !== 'all' && !activeProblems.some((problem) => filter === 'problems' || problem.kind === filter)) continue;
            const row = node('tr');
            const phase = phases[group.phase] || phases.setup;
            const connected = connectedPhases.has(group.phase);
            cell(row, badge(phase[0], phase[1]));
            const peopleCell = node('div');
            const participants = node('div', '', 'cl-participants');
            const meta = node('div', '', 'cl-call-meta');
            peopleCell.appendChild(participants);
            peopleCell.appendChild(meta);
            const trunks = new Set();
            people.forEach((person, position) => {
                if (position) {
                    const join = node('span', connected ? '↔' : '·', 'cl-join');
                    join.setAttribute('aria-hidden', 'true');
                    participants.appendChild(join);
                }
                participants.appendChild(participant(person));
                if (person.trunk) trunks.add(trunkName(person.trunk));
            });
            if (connected || group.call_id) {
                const key = callKey(group);
                const button = node('button', 'Details', 'cl-detail-link cl-call-details');
                button.type = 'button';
                button.dataset.callKey = key;
                button.setAttribute('aria-haspopup', 'dialog');
                button.setAttribute('aria-controls', 'cl-detail');
                meta.appendChild(button);
                callButtons.set(key, button);
                row.className = 'cl-call-open';
                row.addEventListener('click', () => {
                    selectedCall = key;
                    renderCallDetail(data, assigned);
                    if (group.call_id) openRecord(group.call_id, false);
                    detailDialog.showModal();
                });
            }
            for (const problem of activeProblems) meta.appendChild(badge(problem.label, problem.kind === 'wait' ? 'wait' : 'danger'));
            cell(row, peopleCell);
            cell(row, Array.from(trunks).join(', ') || unknown);
            cell(row, connected ? qualityBadge(callQuality(people, group.channels.length))
                : qualityBadge(null, 'Quality is available after the call connects and measurements arrive'));
            cell(row, duration(group.age), 'cl-time cl-call-age');
            rows.push(row);
        }
        return rows;
    }

    function extensionState(hint, entries, connected) {
        const flags = hint > 0 ? hint : 0;
        const hasRing = Boolean(flags & 8) || entries.some((channel) => channel.state === 'ringing');
        const hasBridge = entries.some((channel) => connected.has(channel.id));
        const hasHold = Boolean(flags & 16) || entries.some((channel) => channel.held || connected.get(channel.id) === 'held');
        const inUse = Boolean(flags & 3) || entries.some((channel) => channel.state === 'up');

        if (hasHold) return [hasRing ? 'On hold, second call ringing' : 'On hold', 'wait', true];
        if (hasBridge && hasRing) return ['On a call, second call ringing', 'ok', true];
        if (hasBridge) return ['On a call', 'ok', true];
        if (entries.some((channel) => /off\s?hook/.test(channel.state))) return ['Off hook', 'wait', true];
        if (hasRing && inUse) return ['Busy, second call ringing', 'wait', true];
        if (hasRing) return ['Ringing', 'wait', true];
        if (entries.some((channel) => ['dialing', 'ring', 'pre-ring'].includes(channel.state))) return ['Ringing', 'wait', true];
        if (inUse || entries.length) return ['Busy', 'wait', true];
        if (flags & 4) return ['Unavailable', 'danger', false];
        if (hint === 0) return ['Idle', 'neutral', false];
        return ['No hint', 'neutral', false];
    }

    function apiUrl(command) {
        const url = new URL((window.FreePBX && window.FreePBX.ajaxurl) || 'ajax.php', window.location.href);
        url.searchParams.set('module', 'calllive');
        url.searchParams.set('command', command);
        return url;
    }

    function onOff(value, on = 'Enabled', off = 'Disabled') {
        if (value === null || value === undefined) return unknown;
        if (/^(yes|on|1|true|enabled)$/i.test(String(value))) return on;
        return /^(no|off|0|false|disabled)?$/i.test(String(value)) ? off : unknown;
    }

    function forwarding(value) {
        return value === '' ? 'Disabled' : value;
    }

    function detailCard(title, fields) {
        const card = node('article', '', 'cl-detail-leg');
        card.appendChild(node('h3', title));
        card.appendChild(detailFields(fields));
        return card;
    }

    function sipFields(endpoint) {
        const states = {
            'Not in use': 'Idle', 'In use': 'In use', Unavailable: 'Unavailable',
            Busy: 'Busy', Ringing: 'Ringing', 'On Hold': 'On hold', Unknown: 'Unknown',
            Unmonitored: 'Reachability not monitored',
        };
        const aors = endpoint.aor_details || [];
        const contacts = aors.flatMap((aor) => aor.contacts || []);
        return [
            ['Asterisk state', states[endpoint.state] || endpoint.state],
            ['Address', Array.from(new Set(contacts)).join(', ') || [endpoint.ip, endpoint.port].filter(Boolean).join(':')],
            ['Transport', endpoint.transport],
            ['Codecs', endpoint.codecs],
            ['Context', endpoint.context],
            ['AoR', endpoint.aors],
            ['AoR registrations', aors.filter((aor) => aor.registered !== null)
                .map((aor) => aor.name + ' · ' + aor.registered).join(', ')],
            ['Reachability check', aors.filter((aor) => aor.qualify !== null)
                .map((aor) => aor.name + ' · ' + (Number(aor.qualify) > 0 ? aor.qualify + ' s' : 'Disabled')).join(', ')],
            ['DTMF', endpoint.dtmf],
            ['Media encryption', endpoint.encryption],
            ['Direct media', onOff(endpoint.direct_media)],
            ['SIP device', endpoint.agent],
        ];
    }

    function renderEntityDetail(selection, result) {
        const body = byId('cl-entity-legs');
        const status = byId('cl-entity-status');
        if (result.state !== 'ready') {
            status.textContent = result.state === 'missing' ? 'This entry is missing from the FreePBX directory.'
                : 'Additional details are temporarily unavailable.';
            return;
        }
        status.textContent = 'Details received at ' + new Date().toLocaleTimeString('en-GB');
        const entry = result.entry;
        const signature = JSON.stringify(result);
        if (selection.signature === signature) return;
        selection.signature = signature;
        body.textContent = '';
        if (selection.kind === 'extension') {
            const features = result.features || {};
            const follow = {DIRECT: 'Enabled', EXTENSION: 'Disabled', '': 'Unconfigured'}[features.followme];
            body.appendChild(detailCard('Extension features', [
                ['PBX do not disturb', onOff(features.DND, 'Enabled', 'Disabled')],
                ['Forward all calls', forwarding(features.CF)],
                ['Forward when busy', forwarding(features.CFB)],
                ['Forward on no answer or unavailable', forwarding(features.CFU)],
                ['Call waiting', onOff(features.CW)],
                ['Follow Me', follow],
                ['Follow Me numbers', features.followme_list],
            ]));
            body.appendChild(detailCard('FreePBX settings', [
                ['Outbound caller ID', entry.outboundcid],
                ['Voicemail', entry.voicemail && entry.voicemail !== 'novm' ? entry.voicemail : 'Unconfigured'],
                ['Ring duration', Number(entry.ringtimer) > 0 ? entry.ringtimer + ' s' : 'Default'],
            ]));
            for (const device of result.devices || []) {
                body.appendChild(detailCard('Device ' + device.id, [
                    ['Description', device.description],
                    ['Type', techName(device.tech)],
                    ['Assignment', {fixed: 'Fixed', adhoc: 'Dynamic'}[device.devicetype] || device.devicetype],
                    ['Dial string', device.dial],
                    ...sipFields(device.endpoint || {}),
                ]));
            }
        } else {
            body.appendChild(detailCard('Trunk settings', [
                ['Type', techName(entry.tech)],
                ['Endpoint / peer', entry.channelid],
                ['Enabled in FreePBX', entry.disabled === 'on' ? 'No' : 'Yes'],
                ['Channel limit', Number(entry.maxchans) > 0 ? String(entry.maxchans) : 'Unlimited'],
                ['Outbound caller ID', entry.outcid],
                ['Dial prefix', entry.dialoutprefix],
                ['Provider', entry.provider],
                ['Inbound context', entry.usercontext],
                ['Failover to the next trunk', onOff(entry.continue)],
                ['Outbound routes', (result.routes || []).map((route) => route.name).filter(Boolean).join(', ') || 'Unassigned'],
            ]));
            if (['PJSIP', 'SIP'].includes(techName(entry.tech))) {
                const settings = result.settings || {};
                body.appendChild(detailCard('Signaling', [
                    ['SIP server', [settings.sip_server, settings.sip_server_port].filter(Boolean).join(':')],
                    ['Registration mode', {send: 'Outbound', receive: 'Inbound', none: 'No registration'}[settings.registration]],
                    ['Outbound registration', result.registration],
                    ...sipFields(result.endpoint || {}),
                ]));
            }
        }
    }

    function entityLive(kind, id, state, channels) {
        if (!selectedEntity || selectedEntity.kind !== kind || selectedEntity.id !== id) return;
        const summary = state + ' · Channels ' + channels.length + (channels.length
            ? ' · ' + channels.map((channel) => channel.name).join(', ') : '');
        const line = byId('cl-entity-live');
        if (line.textContent !== summary) line.textContent = summary;
    }

    async function refreshEntity(selection) {
        const controller = new AbortController();
        entityRequest = controller;
        const timer = window.setTimeout(() => controller.abort(), 4500);
        try {
            const url = apiUrl(selection.kind);
            url.searchParams.set('id', selection.id);
            const response = await fetch(url, {
                mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal,
            });
            if (selection !== selectedEntity) return;
            if (response.status === 401 || response.status === 403) {
                snapshot = null;
                inventory = null;
                paint({state: 'access_denied'});
                return;
            }
            if (!response.ok) throw new Error('CallLive details request failed');
            const result = await response.json();
            if (selection === selectedEntity) renderEntityDetail(selection, result);
        } catch (error) {
            if (selection === selectedEntity) renderEntityDetail(selection, {state: 'unavailable'});
        } finally {
            window.clearTimeout(timer);
            if (entityRequest === controller) entityRequest = null;
            if (selection === selectedEntity) {
                entityTimer = window.setTimeout(() => refreshEntity(selection), 10000);
            }
        }
    }

    function entityRow(row, kind, id, label, state, channels) {
        const key = kind + ':' + id;
        const button = node('button', label, 'cl-detail-link cl-entity-link');
        button.type = 'button';
        button.dataset.entityKey = key;
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-controls', 'cl-entity');
        entityButtons.set(key, button);
        row.className = 'cl-call-open';
        row.addEventListener('click', () => {
            const selection = {kind, id, key, signature: ''};
            selectedEntity = selection;
            byId('cl-entity-title').textContent = (kind === 'trunk' ? 'Trunk ' : 'Extension ') + label;
            byId('cl-entity-legs').textContent = '';
            byId('cl-entity-status').textContent = 'Loading details…';
            entityLive(kind, id, state, channels);
            entityDialog.showModal();
            refreshEntity(selection);
        });
        return button;
    }

    function renderExtensions() {
        const search = byId('cl-search').value.trim().toLocaleLowerCase();
        const filtered = extensions.filter(({entry}) => (
            (String(entry.extension) + ' ' + (entry.name || '')).toLocaleLowerCase().includes(search)
        ));
        const rows = filtered.map(({entry, state, channels}) => {
            const row = node('tr');
            const name = node('div', '', 'cl-participant');
            name.appendChild(entityRow(row, 'extension', String(entry.extension), String(entry.extension), state[0], channels));
            if (entry.name) name.appendChild(node('small', entry.name));
            cell(row, name);
            cell(row, badge(state[0], state[1]));
            cell(row, String(channels.length), 'cl-time');
            return row;
        });
        const message = search && extensions.length ? 'No extensions match this search.' : 'The extension list is unavailable.';
        table('cl-extensions', rows, 3, message);
    }

    function paint(data) {
        if (data.thresholds) {
            if (JSON.stringify(data.thresholds) !== JSON.stringify(thresholds)) problems.clear();
            thresholds = data.thresholds;
        }
        updateProblems(data);
        if (data.state === 'access_denied') clearPrivateViews();
        const state = health[data.state] || health.collector_unavailable;
        const status = byId('cl-status');
        if (status.textContent !== state[0]) status.textContent = state[0];
        status.dataset.tone = state[1];
        const notice = byId('cl-notice');
        const details = [state[2]];
        if (inventoryError) details.push('The FreePBX directory is temporarily unavailable.');
        const requiredCollector = data.required_collector_version;
        if (requiredCollector && data.collector_version !== requiredCollector && data.state === 'ready') {
            details.push('Update the collector to ' + requiredCollector + ' in Diagnostics to use history, charts and statistics.');
        }
        if (data.journal && data.journal.storage_error) details.push('History cannot be saved. Check disk space and permissions on /var/lib/freepbx-calllive.');
        if (data.journal && (data.journal.capacity_exceeded || data.journal.capacity_drops)) details.push('The archive has reached its storage limit. Some calls may be missing. See Diagnostics.');
        const daily = data.daily;
        if (!pbxDatesInitialized && daily && /^\d{4}-\d{2}-\d{2}$/.test(daily.date)) {
            pbxDatesInitialized = true;
            for (const key of ['cl-history-from', 'cl-history-to', 'cl-statistics-to']) byId(key).value = daily.date;
            const prior = new Date(daily.date + 'T12:00:00'); prior.setDate(prior.getDate() - 6);
            byId('cl-statistics-from').value = localDate(prior);
        }
        if (daily && daily.storage_error) details.push('Daily counters are temporarily stored in memory.');
        const day = daily && typeof daily.date === 'string' ? daily.date + ' · ' : '';
        byId('cl-daily-date').textContent = 'Today · ' + day + 'PBX time';
        byId('cl-daily-peak').textContent = daily ? measure(daily.peak) : unknown;
        byId('cl-daily-longest').textContent = daily ? formatDuration(daily.longest) : unknown;
        notice.textContent = details.filter(Boolean).join(' ');
        notice.hidden = !notice.textContent;

        if (data.state !== 'ready') {
            byId('cl-updated').textContent = '';
            for (const id of ['cl-count-connections', 'cl-count-trunks', 'cl-count-extensions']) {
                byId(id).textContent = unknown;
            }
            callButtons.clear();
            entityButtons.clear();
            table('cl-calls', [], 5, 'Current calls are unavailable.');
            table('cl-trunks', [], 3, 'Current trunk activity is unavailable.');
            table('cl-extensions', [], 3, 'Current extension states are unavailable.');
            extensions = [];
            renderCallDetail(data);
            if (selectedEntity) {
                byId('cl-entity-live').textContent = 'Current channels are unavailable.';
                if (data.state === 'access_denied') {
                    byId('cl-entity-legs').textContent = '';
                    closeEntity();
                    entityDialog.close();
                }
            }
            return;
        }

        byId('cl-updated').textContent = 'Snapshot ' + timeLabel(data.updated_at);
        const lookup = buildLookups(inventory || {extensions: [], trunks: [], devices: []}, data.hints);
        const assigned = new Map();
        const byExtension = new Map();
        const byTrunk = new Map();
        for (const channel of data.channels) {
            const item = assign(channel, lookup);
            assigned.set(channel.id, item);
            if (item.extension) index(byExtension, String(item.extension.extension), channel);
            if (item.trunk) index(byTrunk, String(item.trunk.trunkid), channel);
        }

        const live = data.groups.filter((group) => connectedPhases.has(group.phase));
        const connected = new Map();
        live.forEach((group) => group.channels.forEach((id) => connected.set(id, group.phase)));
        byId('cl-count-connections').textContent = String(live.length);
        byId('cl-count-trunks').textContent = inventory ? String(byTrunk.size) : unknown;
        const focused = document.activeElement;
        const focusedKey = focused && focused.dataset && focused.dataset.callKey;
        const entityFocus = focused && focused.dataset && focused.dataset.entityKey;
        callButtons.clear();
        entityButtons.clear();
        table('cl-calls', callRows(data, assigned), 5, 'No active calls.');
        if (focusedKey) (callButtons.get(focusedKey) || byId('cl-calls-title')).focus({preventScroll: true});
        renderCallDetail(data, assigned);

        const trunkRows = (inventory ? inventory.trunks : []).map((trunk) => {
            const row = node('tr');
            const id = String(trunk.trunkid);
            const channels = Array.from(byTrunk.get(id) || []);
            const count = channels.length;
            const key = dialKey(techName(trunk.tech) + '/' + trunk.channelid);
            const ambiguous = key && (lookup.trunks.get(key).size > 1
                || lookup.hintDevices.has(key) || lookup.fixedDevices.has(key));
            const disabled = trunk.disabled === 'on';
            const status = count ? ['In use', 'ok'] : !key ? ['Outside channel mapping', 'neutral']
                : ambiguous ? ['Ambiguous channel mapping', 'wait']
                : disabled ? ['Disabled in settings', 'neutral'] : ['0 matched channels', 'neutral'];
            const name = node('div', '', 'cl-participant');
            name.appendChild(entityRow(row, 'trunk', id, trunkName(trunk), status[0], channels));
            name.appendChild(node('small', techName(trunk.tech) + '/' + trunk.channelid));
            cell(row, name);
            cell(row, badge(status[0], status[1]));
            cell(row, key && !ambiguous ? String(count) : unknown, 'cl-time');
            entityLive('trunk', id, status[0], channels);
            return row;
        });
        table('cl-trunks', trunkRows, 3, 'The trunk list is unavailable.');

        extensions = Array.from(lookup.numbers, ([ext, entry]) => {
            const channels = Array.from(byExtension.get(ext) || []);
            const state = extensionState(lookup.states.get(ext), channels, connected);
            entityLive('extension', ext, state[0], channels);
            return {entry, state, channels};
        });
        byId('cl-count-extensions').textContent = inventory
            ? String(extensions.filter(({state}) => state[2]).length) : unknown;
        renderExtensions();
        if (entityFocus && entityButtons.has(entityFocus)) entityButtons.get(entityFocus).focus({preventScroll: true});
    }

    async function refresh() {
        let stop = false;
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 4500);
        try {
            const url = apiUrl('snapshot');
            if (Date.now() - inventoryChecked >= (inventoryError ? 5000 : 30000)) url.searchParams.set('inventory', '1');
            const response = await fetch(url, {
                mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal,
            });
            if (response.status === 401 || response.status === 403) {
                stop = true;
                snapshot = null;
                paint({state: 'access_denied'});
                return;
            }
            if (!response.ok) throw new Error('CallLive request failed');
            const data = await response.json();
            if (url.searchParams.has('inventory')) {
                inventoryChecked = Date.now();
                inventoryError = Boolean(data.inventory_error);
                if (data.inventory) inventory = data.inventory;
            }
            if (!snapshot || data.updated_at !== snapshot.updated_at) receivedAt = performance.now();
            snapshot = data;
            paint(data);
        } catch (error) {
            snapshot = null;
            paint({state: 'request_error'});
        } finally {
            window.clearTimeout(timer);
            if (!stop) window.setTimeout(refresh, 1000);
        }
    }

    detailDialog.addEventListener('close', () => {
        const trigger = callButtons.get(selectedCall) || byId(currentView === 'history' ? 'cl-history-title' : 'cl-calls-title');
        selectedCall = '';
        detailSignature = '';
        lastCall = null;
        byId('cl-detail-legs').textContent = '';
        byId('cl-detail-quality').textContent = '';
        closeRecord();
        trigger.focus({preventScroll: true});
    });
    function closeEntity() {
        if (entityRequest) entityRequest.abort();
        if (entityTimer !== null) window.clearTimeout(entityTimer);
        selectedEntity = null;
        entityTimer = null;
    }
    entityDialog.addEventListener('close', () => {
        const selection = selectedEntity;
        closeEntity();
        byId('cl-entity-legs').textContent = '';
        if (selection) {
            const fallback = selection.kind === 'trunk' ? 'cl-trunks-title' : 'cl-extensions-title';
            (entityButtons.get(selection.key) || byId(fallback)).focus({preventScroll: true});
        }
    });
    byId('cl-search').addEventListener('input', () => {
        if (snapshot && snapshot.state === 'ready') renderExtensions();
    });
    function localDate(date = new Date()) {
        return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
    }

    function dateTime(timestamp) {
        return Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString('en-GB') : unknown;
    }

    function updateProblems(data) {
        if (data.state !== 'ready') {
            problems.clear();
            byId('cl-alerts').hidden = true;
            return;
        }
        const previous = problems;
        problems = new Map();
        for (const group of data.groups || []) {
            const key = callKey(group);
            const channels = (data.channels || []).filter((c) => group.channels.includes(c.id));
            const measured = channels.map((c) => channelQuality(c.rtp)).filter(Boolean);
            const quality = measured.length ? Math.min(...measured.map((q) => q.score)) : null;
            const loss = measured.length ? Math.max(...measured.map((q) => q.loss)) : null;
            const candidates = [];
            if (connectedPhases.has(group.phase) && quality !== null && quality < thresholds.quality) candidates.push(['quality', 'Quality ' + quality + '%']);
            if (connectedPhases.has(group.phase) && loss !== null && loss > thresholds.loss) candidates.push(['loss', 'Loss ' + measure(loss, '%')]);
            if (['ringing', 'queue', 'waiting', 'parked'].includes(group.phase) && group.age >= thresholds.wait) candidates.push(['wait', 'Waiting ' + formatDuration(group.age)]);
            const entries = candidates.map(([kind, label]) => {
                const old = (previous.get(key) || []).find((p) => p.kind === kind);
                const since = old ? old.since : data.updated_at;
                return {kind, label, since, active: data.updated_at - since >= thresholds.sustain};
            });
            if (entries.length) problems.set(key, entries);
        }
        const active = [...problems.values()].flat().filter((p) => p.active);
        const alerts = byId('cl-alerts');
        alerts.textContent = active.length ? 'Active call alerts · ' + active.map((p) => p.label).join('; ') + '.' : '';
        alerts.hidden = !active.length;
    }

    async function apiRead(command, params = {}) {
        const epoch = accessEpoch;
        const url = apiUrl(command);
        for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) url.searchParams.set(key, value);
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 6000);
        try {
            const response = await fetch(url, {mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal});
            if (response.status === 401 || response.status === 403) {
                paint({state: 'access_denied'});
                throw new Error('Access ended.');
            }
            if (!response.ok) throw new Error('The FreePBX request failed.');
            const result = await response.json();
            if (epoch !== accessEpoch) throw new Error('Access ended.');
            return result;
        } finally { window.clearTimeout(timer); }
    }

    function clearPrivateViews() {
        snapshot = null;
        inventory = null;
        extensions = [];
        problems.clear();
        accessEpoch++;
        closeRecord();
        historyGeneration++;
        historyRecords = [];
        historyCursor = null;
        statisticsData = {};
        diagnosis = null;
        for (const id of ['cl-history', 'cl-statistics', 'cl-trunk-peaks', 'cl-load-chart', 'cl-hour-chart', 'cl-diagnostics-fields']) byId(id).textContent = '';
        byId('cl-update').hidden = true;
        byId('cl-update-command').value = '';
        byId('cl-history-more').hidden = true;
        for (const name of ['history', 'statistics', 'diagnostics']) byId('cl-' + name + '-status').textContent = 'Access ended.';
    }

    function closeRecord() {
        if (recordRequest) recordRequest.abort();
        if (recordTimer !== null) window.clearTimeout(recordTimer);
        recordSelection = null;
        recordTimer = null;
        shownRecord = null;
        selectedEvent = null;
        byId('cl-insights').hidden = true;
        byId('cl-record-review').hidden = true;
        byId('cl-clear-marker').hidden = true;
        byId('cl-chart-selection').hidden = true;
        for (const id of ['cl-record-summary', 'cl-quality-explanation', 'cl-chart-channel', 'cl-quality-charts',
            'cl-chart-selection', 'cl-chart-note', 'cl-timeline', 'cl-record-notice']) byId(id).textContent = '';
    }

    function openRecord(id, archived) {
        closeRecord();
        const selection = {id, archived, signature: ''};
        recordSelection = selection;
        byId('cl-insights').hidden = false;
        byId('cl-record-notice').textContent = 'Loading saved call details…';
        if (archived) {
            selectedCall = id;
            byId('cl-detail-legs').textContent = '';
            byId('cl-detail-quality').textContent = '';
            byId('cl-detail-age').textContent = '';
            byId('cl-detail-state').textContent = 'Call history';
            detailDialog.showModal();
        }
        refreshRecord(selection);
    }

    async function refreshRecord(selection) {
        const controller = new AbortController();
        recordRequest = controller;
        const timer = window.setTimeout(() => controller.abort(), 4500);
        let finished = false;
        try {
            const url = apiUrl('call');
            url.searchParams.set('id', selection.id);
            const response = await fetch(url, {credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json'}, signal: controller.signal});
            if (selection !== recordSelection) return;
            if (response.status === 401 || response.status === 403) { paint({state: 'access_denied'}); return; }
            if (!response.ok) throw new Error('Request failed.');
            const result = await response.json();
            if (selection !== recordSelection) return;
            if (result.state !== 'ready') {
                byId('cl-record-notice').textContent = 'This record is pending or has expired. The last available details remain open.';
                return;
            }
            const record = result.record;
            finished = record.status !== 'active';
            const signature = JSON.stringify(record);
            if (selection.signature !== signature) {
                selection.signature = signature;
                shownRecord = record;
                renderRecord(record);
            }
        } catch (error) {
            if (selection === recordSelection) byId('cl-record-notice').textContent = 'The saved details could not be refreshed. The last available details remain open.';
        } finally {
            window.clearTimeout(timer);
            if (recordRequest === controller) recordRequest = null;
            if (!finished && selection === recordSelection) recordTimer = window.setTimeout(() => refreshRecord(selection), 5000);
        }
    }

    const eventNames = {
        start: ['Call monitoring started'], observed: ['Call already in progress when the collector connected'], channel: ['Channel created'],
        dialbegin: ['Dialing started', 'ring'], dialend: ['Dial result'], ringing: ['Ringing', 'ring'], connected: ['Call connected', 'answer'],
        held: ['On hold', 'hold'], hold: ['On hold', 'hold'], unhold: ['Resumed from hold', 'answer'], conference: ['Group call', 'answer'],
        queue: ['Queued', 'hold'], queuecallerjoin: ['Joined queue', 'hold'], queuecallerleave: ['Left queue'],
        agentconnect: ['Connected to agent', 'answer'], agentcomplete: ['Agent leg ended', 'end'],
        blindtransfer: ['Blind transfer', 'transfer'], attendedtransfer: ['Attended transfer', 'transfer'],
        hangup: ['Channel ended', 'end'], end: ['Call ended', 'end'], gap: ['AMI monitoring interrupted', 'gap'], resumed: ['Monitoring resumed', 'answer'],
        parked: ['Call parked', 'hold'], waiting: ['Waiting', 'hold'], service: ['PBX service'], setup: ['Connection setup'],
    };

    const eventIcons = {
        note: ['neutral', 'M8 6h8M8 12h8M8 18h5'],
        ring: ['wait', 'M5 16h14l-2-3V9a5 5 0 0 0-10 0v4l-2 3Zm5 4h4'],
        answer: ['ok', 'm5 12 4 4L19 6'],
        hold: ['wait', 'M9 6v12m6-12v12'],
        transfer: ['accent', 'M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4'],
        end: ['neutral', 'M6 6h12v12H6Z'],
        gap: ['danger', 'M12 5v9m0 4v1'],
    };

    function updateTimelineSelection() {
        for (const button of byId('cl-timeline').querySelectorAll('button[data-event-key]')) {
            button.setAttribute('aria-pressed', String(Boolean(selectedEvent && selectedEvent.key === button.dataset.eventKey)));
        }
    }

    function selectTimelineEvent(event, label, key) {
        const channel = event.channel && shownRecord.channels.find((c) => c.name === event.channel);
        const measured = channel && shownRecord.samples.some((sample) => sample.channels.some((c) => c.id === channel.id));
        byId('cl-chart-channel').value = measured ? channel.id : '';
        selectedEvent = {at: event.at, label, key};
        updateTimelineSelection();
        renderQualityCharts();
        const title = byId('cl-chart-title');
        title.focus({preventScroll: true});
        title.scrollIntoView({block: 'nearest'});
    }

    function renderTimeline(record) {
        const hasSamples = record.samples.length > 0;
        const signature = JSON.stringify([hasSamples, record.answered_at, record.timeline]);
        if (recordSelection.timelineSignature === signature) return;
        recordSelection.timelineSignature = signature;
        const timeline = byId('cl-timeline');
        const scrollTop = timeline.scrollTop;
        const active = document.activeElement;
        const focusedKey = active && active.dataset && active.dataset.eventKey;
        let focused = null;
        const perSecond = new Map();
        timeline.textContent = '';
        for (const event of record.timeline) {
            const entryType = eventNames[event.kind];
            const [name, style = 'note'] = Array.isArray(entryType) ? entryType : [event.kind || 'Event'];
            const label = event.kind === 'connected' && event.at === record.answered_at ? 'Call answered' : name;
            const [tone, path] = eventIcons[style];
            const entry = node('li');
            const icon = node('span', '', 'cl-event-icon');
            icon.dataset.tone = tone;
            icon.setAttribute('aria-hidden', 'true');
            const graphic = svgNode('svg', {viewBox: '0 0 24 24', focusable: 'false'});
            graphic.appendChild(svgNode('path', {d: path}));
            icon.appendChild(graphic);
            entry.appendChild(icon);

            const hasTime = Number.isFinite(event.at);
            const interactive = hasSamples && hasTime;
            const card = node(interactive ? 'button' : 'div', '', 'cl-event-card');
            card.appendChild(node('strong', label));
            const time = hasTime ? timeLabel(event.at) : unknown;
            const stamp = node('time', time);
            if (hasTime) stamp.setAttribute('datetime', time);
            card.appendChild(stamp);
            const detail = [event.channel, event.queue && 'Queue ' + event.queue,
                event.target, event.result, event.cause && 'Cause ' + event.cause, event.reason].filter(Boolean).join(' · ');
            if (detail) card.appendChild(node('span', detail, 'cl-event-detail'));
            if (interactive) {
                const ordinal = (perSecond.get(event.at) || 0) + 1;
                perSecond.set(event.at, ordinal);
                const key = event.at + ':' + ordinal;
                card.type = 'button';
                card.dataset.eventKey = key;
                card.setAttribute('aria-controls', 'cl-quality-charts');
                card.setAttribute('aria-pressed', String(Boolean(selectedEvent && selectedEvent.key === key)));
                card.appendChild(node('span', 'View charts ↗', 'cl-event-action'));
                card.addEventListener('click', () => selectTimelineEvent(event, label, key));
                if (key === focusedKey) focused = card;
            }
            entry.appendChild(card);
            timeline.appendChild(entry);
        }
        timeline.scrollTop = scrollTop;
        if (focusedKey) (focused || byId('cl-timeline-title')).focus({preventScroll: true});
        if (!record.timeline.length) timeline.appendChild(node('li', 'No events available yet.', 'cl-event-empty'));
    }

    function renderRecord(record) {
        byId('cl-record-summary').textContent = 'Started ' + dateTime(record.started_at)
            + ' · Answered ' + dateTime(record.answered_at) + ' · Ended ' + dateTime(record.ended_at)
            + ' · Observed talk time ' + formatDuration(Math.floor(record.talk_seconds))
            + (record.gap ? ' · Monitoring was interrupted for part of this call.' : '');
        const quality = record.last_quality;
        const worst = record.worst_quality;
        byId('cl-quality-explanation').textContent = '';
        byId('cl-quality-explanation').appendChild(node('p',
            'Score = 100 × loss factor × jitter factor × RTT factor. The dashboard uses the lowest score among measured channels. '
            + 'The loss factor is 100% through 0.1% loss and 0% at 10%. The jitter bounds are 20 and 100 ms, and the RTT bounds are 150 and 800 ms. '
            + 'Each factor decreases linearly between its bounds. The score summarizes RTP/RTCP transport measurements.', 'cl-detail-note'));
        byId('cl-quality-explanation').appendChild(detailFields([
            ['Latest quality', quality ? quality.score + '% · ' + timeLabel(quality.at) + (quality.partial ? ' · partial data' : '') : 'Insufficient measurements'],
            ['Worst quality', worst ? worst.score + '% · ' + timeLabel(worst.at) + (worst.partial ? ' · partial data' : '') : unknown],
            ['Latest sample coverage', quality ? quality.coverage[0] + ' of ' + quality.coverage[1] + ' channels' : unknown],
        ]));
        const latest = record.samples.length ? record.samples[record.samples.length - 1] : null;
        if (latest) for (const q of latest.channels) {
            const channel = record.channels.find((c) => c.id === q.id);
            byId('cl-quality-explanation').appendChild(detailCard(channel ? channel.name : q.id, [
                ['Channel quality', q.score + '%' + (q.partial ? ' · partial' : '')],
                ['Loss', measure(q.loss, '%') + ' · factor ' + measure(q.factors.loss)],
                ['Jitter', measure(q.jitter, ' ms') + ' · factor ' + measure(q.factors.jitter)],
                ['RTT', measure(q.rtt, ' ms') + ' · factor ' + measure(q.factors.rtt)],
                ['Sample time', dateTime(q.sampled_at)],
            ]));
        }
        const selector = byId('cl-chart-channel');
        const old = selector.value;
        selector.textContent = '';
        const option = node('option', 'Worst measurements across all channels'); option.value = ''; selector.appendChild(option);
        for (const c of record.channels) { const o = node('option', c.name); o.value = c.id; selector.appendChild(o); }
        selector.value = record.channels.some((c) => c.id === old) ? old : '';
        byId('cl-record-review').hidden = false;
        renderTimeline(record);
        renderQualityCharts();
        const causes = (record.causes || []).map((c) => c.channel + ': ' + c.code + ' ' + c.text);
        byId('cl-record-notice').textContent = [causes.length ? 'Asterisk hangup causes · ' + causes.join('; ') : '',
            record.status !== 'active' && !causes.length ? 'Asterisk did not report a hangup cause.' : '',
            record.stale ? 'The last snapshot is stale. The current call state is unknown.' : '',
            record.limited ? 'This long record was condensed. The charts retain the worst points from adjacent intervals, and some early events were omitted.' : '',
            record.gap ? 'Monitoring was interrupted. The duration and event sequence may be incomplete.' : '',
        ].filter(Boolean).join(' ');
        if (record.status !== 'active' || recordSelection.archived) {
            byId('cl-detail-state').textContent = record.status === 'active' ? 'Call still active' : 'Call ended. Details saved.';
            byId('cl-detail-age').textContent = 'Total call time ' + formatDuration(Math.max(0, (record.ended_at || record.last_seen) - record.started_at));
            byId('cl-detail-quality').textContent = 'Quality ';
            byId('cl-detail-quality').appendChild(qualityBadge(quality));
            const lookup = buildLookups(inventory || {extensions: [], devices: [], trunks: []}, []);
            const legs = byId('cl-detail-legs'); legs.textContent = '';
            for (const c of record.channels) legs.appendChild(channelDetails(assign(c, lookup)));
        }
    }

    function svgNode(tag, attrs, value = '') {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        for (const [name, v] of Object.entries(attrs || {})) el.setAttribute(name, String(v));
        if (value) el.textContent = value;
        return el;
    }

    function lineChart(title, values, unit, fixedMax = null) {
        const box = node('figure', '', 'cl-chart');
        box.appendChild(node('figcaption', title));
        const known = values.filter((p) => Number.isFinite(p.value));
        if (!known.length) { box.appendChild(node('p', 'Measurements unavailable', 'cl-detail-note')); return box; }
        const eventLabel = selectedEvent ? selectedEvent.label + ' · ' + timeLabel(selectedEvent.at) : '';
        const svg = svgNode('svg', {viewBox: '0 0 440 160', role: 'img', 'aria-label': [title, eventLabel].filter(Boolean).join(' · ')});
        const first = values[0].at;
        const last = values[values.length - 1].at;
        const minT = selectedEvent ? Math.min(first, selectedEvent.at) : first;
        const maxT = selectedEvent ? Math.max(last, selectedEvent.at) : last;
        const maximum = fixedMax || Math.max(1, ...known.map((p) => p.value)) * 1.1;
        const left = 56;
        const right = 422;
        const x = (t) => left + (t - minT) / Math.max(1, maxT - minT) * (right - left);
        const y = (v) => 130 - Math.min(maximum, v) / maximum * 105;
        for (const v of [0, maximum / 2, maximum]) {
            svg.appendChild(svgNode('line', {x1: left, x2: right, y1: y(v), y2: y(v), stroke: '#d9e3e9'}));
            svg.appendChild(svgNode('text', {x: left - 5, y: y(v) + 4, 'text-anchor': 'end'}, detailNumber.format(v)));
        }
        if (selectedEvent) {
            const at = x(selectedEvent.at);
            const marker = svgNode('line', {x1: at, x2: at, y1: 22, y2: 132, class: 'cl-chart-event-marker', 'data-event-at': selectedEvent.at});
            marker.appendChild(svgNode('title', {}, eventLabel));
            svg.appendChild(marker);
        }
        let path = ''; let previous = null;
        for (const p of values) {
            if (!Number.isFinite(p.value)) { previous = null; continue; }
            const breakLine = !previous || p.at - previous.at > Math.max(20, (shownRecord ? shownRecord.sample_interval : 5) * 3);
            path += (breakLine ? 'M' : 'L') + x(p.at).toFixed(2) + ',' + y(p.value).toFixed(2) + ' ';
            previous = p;
        }
        svg.appendChild(svgNode('path', {d: path, fill: 'none', stroke: '#187a7c', 'stroke-width': 2}));
        for (const p of known) {
            const dot = svgNode('circle', {cx: x(p.at), cy: y(p.value), r: 2.5, fill: '#187a7c'});
            dot.appendChild(svgNode('title', {}, dateTime(p.at) + ': ' + measure(p.value, unit)));
            svg.appendChild(dot);
        }
        svg.appendChild(svgNode('text', {x: left, y: 151}, timeLabel(minT)));
        svg.appendChild(svgNode('text', {x: right, y: 151, 'text-anchor': 'end'}, timeLabel(maxT)));
        box.appendChild(svg);
        return box;
    }

    function renderQualityCharts() {
        if (!shownRecord) return;
        const body = byId('cl-quality-charts'); body.textContent = '';
        const selection = byId('cl-chart-selection');
        const message = selectedEvent ? 'Marker · ' + timeLabel(selectedEvent.at) + ' · ' + selectedEvent.label : '';
        if (selection.textContent !== message) selection.textContent = message;
        selection.hidden = !selectedEvent;
        byId('cl-clear-marker').hidden = !selectedEvent;
        const selected = byId('cl-chart-channel').value;
        const metrics = [['score', 'Quality, %', '%', 100], ['loss', 'Packet loss, %', '%'],
            ['jitter', 'Receive jitter, ms', ' ms'], ['rtt', 'RTT, ms', ' ms']];
        for (const [key, label, unit, max] of metrics) {
            const values = shownRecord.samples.map((sample) => {
                const known = sample.channels.filter((c) => (!selected || c.id === selected) && Number.isFinite(c[key]));
                return {at: sample.at, value: known.length ? (key === 'score' ? Math.min : Math.max)(...known.map((c) => c[key])) : null};
            });
            body.appendChild(lineChart(label, values, unit, max));
        }
        byId('cl-chart-note').textContent = 'Points show measurements reported by Asterisk, usually every five seconds. Packet loss uses the reporting window of the RTP/RTCP counters. '
            + 'Missing samples appear as gaps. Saved interval up to ' + shownRecord.sample_interval + ' s. Hover over a point to see its value and time.';
    }

    function historyParams(more) {
        return {from: byId('cl-history-from').value, to: byId('cl-history-to').value,
            search: byId('cl-history-search').value.trim(), problem: byId('cl-history-problem').checked ? '1' : '0',
            cursor: more ? historyCursor : null};
    }

    async function loadHistory(more = false) {
        const generation = ++historyGeneration;
        if (!more) { historyRecords = []; historyCursor = null; }
        byId('cl-history-status').textContent = 'Searching…';
        byId('cl-history-more').hidden = true;
        try {
            const result = await apiRead('history', historyParams(more));
            if (generation !== historyGeneration) return;
            if (result.state !== 'ready') throw new Error('Select a valid date range of up to 31 days.');
            const seen = new Set(historyRecords.map((r) => r.id));
            historyRecords.push(...result.records.filter((r) => !seen.has(r.id)));
            historyCursor = result.cursor;
            const rows = historyRecords.map((r) => {
                const row = node('tr');
                cell(row, dateTime(r.started_at) + ' → ' + dateTime(r.ended_at));
                const people = node('div', '', 'cl-participant');
                const trigger = node('button', r.participants.join(' ↔ ') || 'Details', 'cl-detail-link');
                trigger.type = 'button';
                trigger.addEventListener('click', () => openRecord(r.id, true));
                people.appendChild(trigger);
                people.appendChild(node('small', r.endpoints.join(', ')));
                callButtons.set(r.id, trigger);
                cell(row, people);
                cell(row, formatDuration(r.talk_seconds) + ' / ' + formatDuration(r.duration));
                const scores = node('span'); scores.appendChild(qualityBadge(r.last_quality)); scores.appendChild(node('span', ' / ')); scores.appendChild(qualityBadge(r.worst_quality)); cell(row, scores);
                cell(row, (r.answered ? 'Answered' : 'Answer not confirmed') + (r.gap ? ' · incomplete data' : ''));
                return row;
            });
            table('cl-history', rows, 5, 'No calls found for this period.');
            byId('cl-history-status').textContent = !result.available ? 'History is unavailable. Check the collector version and service.'
                : 'Showing ' + historyRecords.length + '. ' + (result.partial ? 'The search reached its time limit. Select Load more to continue.' : 'Open a call to view its technical details.');
            byId('cl-history-more').hidden = !historyCursor;
        } catch (error) { if (generation === historyGeneration) byId('cl-history-status').textContent = error.message; }
    }

    function bars(title, entries) {
        const box = node('figure', '', 'cl-chart'); box.appendChild(node('figcaption', title));
        if (!entries.length) { box.appendChild(node('p', 'No observations', 'cl-detail-note')); return box; }
        const svg = svgNode('svg', {viewBox: '0 0 900 210', role: 'img', 'aria-label': title});
        const maximum = Math.max(1, ...entries.map((e) => e.value || 0));
        const width = 850 / entries.length;
        entries.forEach((entry, i) => {
            const height = (entry.value || 0) / maximum * 140;
            const bar = svgNode('rect', {x: 30 + width * i, y: 166 - height, width: Math.max(1, width - 5), height: Math.max(1, height), fill: entry.known ? '#187a7c' : '#c1cdd5'});
            bar.appendChild(svgNode('title', {}, entry.label + ': ' + (entry.known ? entry.value : 'no observations')));
            svg.appendChild(bar);
            svg.appendChild(svgNode('text', {x: 30 + width * (i + .45), y: 185, 'text-anchor': 'middle'}, entry.label));
            if (entry.known) svg.appendChild(svgNode('text', {x: 30 + width * (i + .45), y: 158 - height, 'text-anchor': 'middle'}, String(entry.value)));
        });
        box.appendChild(svg); return box;
    }

    function renderHours() {
        const day = byId('cl-stat-day').value;
        const stats = statisticsData[day];
        const values = Array.from({length: 24}, (_, i) => {
            const hour = String(i).padStart(2, '0'); const slot = stats && stats.hours[hour];
            return {label: hour, value: slot ? slot.peak : 0, known: Boolean(slot)};
        });
        byId('cl-hour-chart').textContent = '';
        byId('cl-hour-chart').appendChild(bars('Peak simultaneous calls by hour · ' + day, values));
    }

    async function loadStatistics() {
        byId('cl-statistics-status').textContent = 'Loading…';
        try {
            const result = await apiRead('statistics', {from: byId('cl-statistics-from').value, to: byId('cl-statistics-to').value});
            if (result.state !== 'ready') throw new Error(result.state === 'invalid' ? 'Select a date range of up to 31 days.' : 'Statistics are unavailable. Check or update the collector.');
            statisticsData = result.days;
            const rows = Object.entries(result.days).map(([day, s]) => {
                const row = node('tr'); cell(row, day); cell(row, String(s.calls || 0) + ' / ' + String(s.answered || 0));
                cell(row, String(s.peak)); cell(row, formatDuration(Math.floor(s.longest || 0)));
                cell(row, formatDuration(Math.floor(Math.min(86400, s.observed_seconds || 0)))); return row;
            });
            table('cl-statistics', rows, 5, 'No observations for this period.');
            const select = byId('cl-stat-day'); const old = select.value; select.textContent = '';
            for (const day of Object.keys(result.days)) { const o = node('option', day); o.value = day; select.appendChild(o); }
            select.value = result.days[old] ? old : Object.keys(result.days).slice(-1)[0] || '';
            byId('cl-load-chart').textContent = '';
            byId('cl-load-chart').appendChild(bars('Peak simultaneous calls by day', Object.entries(result.days).map(([day, s]) => ({label: day.slice(5), value: s.peak, known: true}))));
            renderHours();
            const trunkRows = (inventory ? inventory.trunks : []).map((trunk) => {
                const key = techName(trunk.tech) + '/' + trunk.channelid;
                const peak = Math.max(0, ...Object.values(result.days).map((s) => s.endpoints[key] || 0));
                const row = node('tr'); cell(row, trunkName(trunk)); cell(row, String(peak)); return row;
            });
            table('cl-trunk-peaks', trunkRows, 2, 'The trunk directory is unavailable.');
            byId('cl-statistics-status').textContent = 'Statistics snapshot ' + dateTime(result.updated_at) + '. Statistics are collected while the current collector is running.';
        } catch (error) { byId('cl-statistics-status').textContent = error.message; }
    }

    async function loadDiagnostics() {
        byId('cl-diagnostics-status').textContent = 'Checking…';
        try {
            const d = await apiRead('diagnostics');
            diagnosis = d;
            const runtime = d.runtime || {}; const journal = d.journal || {};
            byId('cl-diagnostics-fields').textContent = '';
            byId('cl-diagnostics-fields').appendChild(detailFields([
                ['Module', d.module_version], ['Collector', d.collector_version || 'Unknown version. The collector may be outdated or the snapshot may be stale.'],
                ['Compatibility', d.compatible ? 'Collector is compatible' : 'Collector update or service check required'],
                ['PBX connection', (health[d.pbx_state] || health.collector_unavailable)[0]],
                ['Latest snapshot', dateTime(d.updated_at)], ['Snapshot / history readable', (d.snapshot_readable ? 'Yes' : 'No') + ' / ' + (d.journal_readable ? 'Yes' : 'No')],
                ['Python', runtime.python], ['Collector uptime', Number.isFinite(runtime.uptime_seconds) ? formatDuration(runtime.uptime_seconds) : unknown],
                ['Sample interval / maximum RTP age', runtime.sample_interval ? runtime.sample_interval + ' / ' + runtime.media_max_age + ' s' : unknown],
                ['Retention', journal.retention_days ? journal.retention_days + ' days, up to ' + journal.max_mb + ' MiB of archived calls' : unknown],
                ['History storage', journal.storage_error ? 'Write error. Check disk space and permissions.' : d.journal_readable ? 'Available' : 'Unavailable'],
                ['Calls skipped at storage limit', String(journal.capacity_drops || 0)],
                ['Quality / loss thresholds', d.thresholds.quality + '% / ' + d.thresholds.loss + '%'],
                ['Wait / alert persistence', d.thresholds.wait + ' / ' + d.thresholds.sustain + ' s'],
            ]));
            byId('cl-update').hidden = !d.can_manage;
            byId('cl-update-command').value = d.update_command || '';
            if (d.can_manage) for (const key of Object.keys(d.thresholds)) byId('cl-setting-' + key).value = d.thresholds[key];
            byId('cl-diagnostics-status').textContent = d.compatible ? 'Diagnostics complete. ' + (health[d.pbx_state] || health.collector_unavailable)[2]
                : 'History, charts and statistics require collector ' + d.required_collector_version + '. An administrator with full access can update it.';
        } catch (error) { byId('cl-diagnostics-status').textContent = error.message; }
    }

    async function saveThresholds(event) {
        event.preventDefault();
        const status = byId('cl-settings-status');
        const body = new URLSearchParams({csrf: root.dataset.csrf || ''});
        for (const key of ['quality', 'loss', 'wait', 'sustain']) body.set(key, byId('cl-setting-' + key).value);
        try {
            const response = await fetch(apiUrl('settings'), {method: 'POST', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                headers: {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}, body});
            if (response.status === 401 || response.status === 403) throw new Error('A valid session and full admin access are required. Refresh the page.');
            if (!response.ok) throw new Error('Could not save the settings.');
            const result = await response.json();
            if (result.state !== 'ready') throw new Error('Check the allowed value ranges.');
            thresholds = result.thresholds; problems.clear(); status.textContent = 'Thresholds saved for all users.';
        } catch (error) { status.textContent = error.message; }
    }

    function selectView(name) {
        currentView = name;
        for (const key of ['monitor', 'history', 'statistics', 'diagnostics']) byId('cl-view-' + key).hidden = name !== key;
        for (const button of root.querySelectorAll('[data-cl-view]')) button.setAttribute('aria-pressed', String(button.dataset.clView === name));
        if (name === 'history') loadHistory();
        if (name === 'statistics') loadStatistics();
        if (name === 'diagnostics') loadDiagnostics();
    }

    const today = localDate();
    const week = new Date(); week.setDate(week.getDate() - 6);
    byId('cl-history-from').value = today; byId('cl-history-to').value = today;
    byId('cl-statistics-from').value = localDate(week); byId('cl-statistics-to').value = today;
    if (root.querySelectorAll) for (const button of root.querySelectorAll('[data-cl-view]')) button.addEventListener('click', () => selectView(button.dataset.clView));
    byId('cl-history-form').addEventListener('submit', (event) => { event.preventDefault(); loadHistory(); });
    byId('cl-history-more').addEventListener('click', () => loadHistory(true));
    byId('cl-statistics-form').addEventListener('submit', (event) => { event.preventDefault(); loadStatistics(); });
    byId('cl-diagnostics-refresh').addEventListener('click', loadDiagnostics);
    byId('cl-chart-channel').addEventListener('change', renderQualityCharts);
    byId('cl-clear-marker').addEventListener('click', () => {
        selectedEvent = null;
        updateTimelineSelection();
        renderQualityCharts();
        byId('cl-chart-title').focus({preventScroll: true});
    });
    byId('cl-stat-day').addEventListener('change', renderHours);
    byId('cl-problem-filter').addEventListener('change', () => { if (snapshot) paint(snapshot); });
    byId('cl-threshold-form').addEventListener('submit', saveThresholds);
    byId('cl-copy-update').addEventListener('click', async () => {
        const field = byId('cl-update-command');
        try {
            await navigator.clipboard.writeText(field.value);
            byId('cl-settings-status').textContent = 'Command copied.';
        } catch (error) {
            field.focus(); field.select();
            byId('cl-settings-status').textContent = 'The command is selected. Press Ctrl+C to copy it.';
        }
    });

    refresh();
})();
