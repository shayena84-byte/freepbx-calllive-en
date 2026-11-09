<?php

namespace FreePBX\modules;

class Calllive implements \BMO
{
    const VERSION = '15.0.10';
    const COLLECTOR_VERSION = '15.0.8';
    const STORAGE = '/var/lib/freepbx-calllive';
    const SNAPSHOT = '/run/freepbx-calllive/snapshot.json';
    const MAX_BYTES = 4194304;
    const MAX_AGE = 18;

    private $freepbx;
    private $historyBusy = false;

    public function __construct($freepbx)
    {
        $this->freepbx = $freepbx;
    }

    public function install()
    {
        $this->freepbx->Database->exec('CREATE TABLE IF NOT EXISTS calllive_settings (
            id TINYINT NOT NULL PRIMARY KEY, value TEXT NOT NULL) ENGINE=InnoDB');
    }
    public function uninstall() {}
    public function backup() {}
    public function restore($backup) {}
    public function doConfigPageInit($page) {}

    public function canView()
    {
        if (!isset($_SESSION['AMP_user']) || !($_SESSION['AMP_user'] instanceof \ampuser)) {
            return false;
        }
        $user = $_SESSION['AMP_user'];
        // This section grants PBX-wide read access to the monitor and its detail cards.
        if (!$user->checkSection('calllive')) {
            return false;
        }

        $timeout = (int) $this->freepbx->Config->get('SESSION_TIMEOUT');
        if ($timeout > 0 && (empty($user->_lastactivity)
            || time() - (int) $user->_lastactivity > max(60, $timeout))) {
            return false;
        }
        return $this->freepbx->Modules->checkStatus('calllive');
    }

    public function ajaxRequest($request, &$settings)
    {
        if (!$this->canView() || !isset($_SERVER['REQUEST_METHOD'])) return false;
        if ($request === 'settings') {
            return $_SERVER['REQUEST_METHOD'] === 'POST' && $this->canManage()
                && isset($_POST['csrf'], $_SESSION['calllive_csrf']) && is_string($_POST['csrf'])
                && hash_equals($_SESSION['calllive_csrf'], $_POST['csrf']);
        }
        return $_SERVER['REQUEST_METHOD'] === 'GET'
            && in_array($request, array('snapshot', 'extension', 'trunk', 'history', 'call', 'statistics', 'diagnostics'), true);
    }

    public function ajaxHandler()
    {
        $this->freepbx->Ajax->addHeader('Cache-Control', 'no-store, private');
        if (!$this->canView()) {
            $this->freepbx->Ajax->ajaxError(403, 'CallLive access denied');
        }

        $command = isset($_GET['command']) ? $_GET['command'] : '';
        if ($command === 'settings') return $this->saveSettings();
        if ($command === 'history') return $this->history();
        if ($command === 'call') return $this->callDetail();
        if ($command === 'statistics') return $this->statistics();
        if ($command === 'diagnostics') return $this->diagnostics();
        if ($command === 'extension' || $command === 'trunk') {
            $id = isset($_GET['id']) && is_string($_GET['id']) ? $_GET['id'] : '';
            $format = $command === 'extension' ? '/\A[A-Za-z0-9*#_.+\-]{1,20}\z/' : '/\A[0-9]{1,10}\z/';
            if (!preg_match($format, $id)) {
                return array('state' => 'missing');
            }
            // Avoid holding the admin session lock while asking Asterisk for details.
            session_write_close();
            try {
                return $command === 'extension' ? $this->extensionDetail($id) : $this->trunkDetail($id);
            } catch (\Exception $error) {
                return array('state' => 'unavailable');
            }
        }

        $snapshot = $this->readSnapshot();
        $snapshot['thresholds'] = $this->thresholds();
        $snapshot['module_version'] = self::VERSION;
        $snapshot['required_collector_version'] = self::COLLECTOR_VERSION;
        if (isset($_GET['inventory']) && $_GET['inventory'] === '1') {
            try {
                $database = $this->freepbx->Database;
                $snapshot['inventory'] = array(
                    'extensions' => $database->query(
                        'SELECT `extension`, `name` FROM `users` ORDER BY `extension`'
                    )->fetchAll(\PDO::FETCH_ASSOC),
                    'devices' => $database->query(
                        'SELECT `id`, `tech`, `dial`, `user`, `devicetype` FROM `devices` ORDER BY `id`'
                    )->fetchAll(\PDO::FETCH_ASSOC),
                    'trunks' => $database->query(
                        'SELECT `trunkid`, `tech`, `channelid`, `name`, `disabled` FROM `trunks` ORDER BY `trunkid`'
                    )->fetchAll(\PDO::FETCH_ASSOC),
                );
            } catch (\Exception $error) {
                $snapshot['inventory_error'] = true;
            }
        }
        return $snapshot;
    }

    public function canManage()
    {
        return $this->canView() && $_SESSION['AMP_user']->checkSection('*');
    }

    public function csrfToken()
    {
        if (!$this->canManage()) return '';
        if (session_status() !== PHP_SESSION_ACTIVE) session_start();
        if (empty($_SESSION['calllive_csrf'])) {
            $strong = false;
            $bytes = function_exists('random_bytes') ? random_bytes(24) : openssl_random_pseudo_bytes(24, $strong);
            if (!is_string($bytes) || strlen($bytes) !== 24 || (!function_exists('random_bytes') && !$strong)) return '';
            $_SESSION['calllive_csrf'] = bin2hex($bytes);
        }
        return $_SESSION['calllive_csrf'];
    }

    private function thresholds()
    {
        $defaults = array('quality' => 65, 'loss' => 2, 'wait' => 30, 'sustain' => 10);
        try {
            $text = $this->freepbx->Database->query('SELECT value FROM calllive_settings WHERE id = 1')->fetchColumn();
            $saved = json_decode($text, true);
            if (is_array($saved)) foreach ($defaults as $key => $value) {
                if (isset($saved[$key]) && is_numeric($saved[$key])) $defaults[$key] = (float) $saved[$key];
            }
        } catch (\Exception $error) {}
        return $defaults;
    }

    private function saveSettings()
    {
        if (!$this->canManage() || !isset($_POST['csrf'], $_SESSION['calllive_csrf'])
            || !is_string($_POST['csrf']) || !hash_equals($_SESSION['calllive_csrf'], $_POST['csrf'])) {
            $this->freepbx->Ajax->ajaxError(403, 'CallLive settings denied');
        }
        $values = array();
        foreach (array('quality' => array(0, 100), 'loss' => array(.1, 100),
            'wait' => array(5, 3600), 'sustain' => array(0, 300)) as $key => $range) {
            $value = isset($_POST[$key]) && is_string($_POST[$key]) ? $_POST[$key] : '';
            if (!preg_match('/\A[0-9]{1,4}(?:\.[0-9]{1,2})?\z/', $value)
                || (float) $value < $range[0] || (float) $value > $range[1]) return array('state' => 'invalid');
            $values[$key] = (float) $value;
        }
        $query = $this->freepbx->Database->prepare('INSERT INTO calllive_settings (id, value) VALUES (1, ?)
            ON DUPLICATE KEY UPDATE value = VALUES(value)');
        $query->execute(array(json_encode($values)));
        return array('state' => 'ready', 'thresholds' => $values);
    }

    private function readJson($path, $limit = self::MAX_BYTES)
    {
        $text = is_readable($path) ? @file_get_contents($path, false, null, 0, $limit + 1) : false;
        $data = is_string($text) && strlen($text) <= $limit ? json_decode($text, true) : null;
        return is_array($data) && isset($data['schema']) && $data['schema'] === 1 ? $data : null;
    }

    private function validDate($value)
    {
        return is_string($value) && preg_match('/\A([0-9]{4})-([0-9]{2})-([0-9]{2})\z/', $value, $m)
            && checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
    }

    private function dateRange()
    {
        $from = isset($_GET['from']) ? $_GET['from'] : date('Y-m-d');
        $to = isset($_GET['to']) ? $_GET['to'] : date('Y-m-d');
        if (!$this->validDate($from) || !$this->validDate($to) || $from > $to
            || (new \DateTime($from))->diff(new \DateTime($to))->days > 30) return null;
        $days = array();
        $day = new \DateTime($to);
        while ($day->format('Y-m-d') >= $from && count($days) < 31) {
            $days[] = $day->format('Y-m-d');
            $day->modify('-1 day');
        }
        return $days;
    }

    private function callDetail()
    {
        $id = isset($_GET['id']) && is_string($_GET['id']) ? $_GET['id'] : '';
        if (!preg_match('/\A([0-9]{4})([0-9]{2})([0-9]{2})-[0-9a-f]{24}\z/', $id, $m)
            || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) return array('state' => 'missing');
        $day = $m[1] . '-' . $m[2] . '-' . $m[3];
        $record = $this->readJson(self::STORAGE . '/archive/' . $day . '/' . $id . '.json', 2097152);
        if (!$record) $record = $this->readJson(self::STORAGE . '/live/' . $id . '.json', 2097152);
        if (!$record || !isset($record['id']) || $record['id'] !== $id) return array('state' => 'missing');
        $record['stale'] = $record['status'] === 'active' && time() - $record['last_seen'] > self::MAX_AGE;
        return array('state' => 'ready', 'record' => $record);
    }

    private function reverseLines($path, $position)
    {
        $file = @fopen($path, 'rb');
        if (!$file) return;
        if (!flock($file, LOCK_SH | LOCK_NB)) { $this->historyBusy = true; fclose($file); return; }
        $size = fstat($file)['size'];
        $pos = min($size, $position === null ? $size : $position);
        $tail = '';
        while ($pos > 0) {
            $bytes = min(8192, $pos);
            $pos -= $bytes;
            fseek($file, $pos);
            $tail = fread($file, $bytes) . $tail;
            while (($index = strrpos($tail, "\n")) !== false) {
                $line = substr($tail, $index + 1);
                $tail = substr($tail, 0, $index);
                if ($line !== '' && strlen($line) <= 16384) yield array($line, $pos + $index + 1);
            }
            if (strlen($tail) > 16384) break;
        }
        if ($tail !== '' && strlen($tail) <= 16384) yield array($tail, 0);
        flock($file, LOCK_UN);
        fclose($file);
    }

    private function history()
    {
        $days = $this->dateRange();
        $search = isset($_GET['search']) && is_string($_GET['search']) ? trim($_GET['search']) : '';
        if (!$days || strlen($search) > 100) return array('state' => 'invalid');
        $cursor = null;
        if (!empty($_GET['cursor'])) {
            if (!is_string($_GET['cursor']) || strlen($_GET['cursor']) > 150) return array('state' => 'invalid');
            $cursor = json_decode(base64_decode($_GET['cursor'], true), true);
            if (!is_array($cursor) || !isset($cursor['day'], $cursor['pos'])
                || !in_array($cursor['day'], $days, true) || !is_int($cursor['pos']) || $cursor['pos'] < 0) return array('state' => 'invalid');
        }
        $records = array(); $seen = array(); $scanned = 0; $next = null;
        $deadline = microtime(true) + 1.5;
        $problem = isset($_GET['problem']) && $_GET['problem'] === '1';
        $threshold = $this->thresholds()['quality'];
        foreach ($days as $day) {
            if ($cursor && $day > $cursor['day']) continue;
            $position = $cursor && $day === $cursor['day'] ? $cursor['pos'] : null;
            foreach ($this->reverseLines(self::STORAGE . '/archive/' . $day . '/catalog.jsonl', $position) as $line) {
                $row = json_decode($line[0], true);
                $scanned++;
                if (is_array($row) && isset($row['id']) && !isset($seen[$row['id']])) {
                    $seen[$row['id']] = true;
                    $haystack = implode(' ', array_merge(isset($row['numbers']) ? $row['numbers'] : array(),
                        isset($row['endpoints']) ? $row['endpoints'] : array(), isset($row['participants']) ? $row['participants'] : array()));
                    $matches = $search === '' || stripos($haystack, $search) !== false;
                    if ($matches && (!$problem || (isset($row['worst_quality']['score']) && $row['worst_quality']['score'] < $threshold))) $records[] = $row;
                }
                if (count($records) >= 50 || $scanned >= 50000 || microtime(true) >= $deadline) {
                    $next = base64_encode(json_encode(array('day' => $day, 'pos' => $line[1])));
                    break 2;
                }
            }
            if ($this->historyBusy) {
                $next = base64_encode(json_encode(array('day' => $day, 'pos' => $position === null ? PHP_INT_MAX : $position)));
                break;
            }
        }
        return array('state' => 'ready', 'records' => $records, 'cursor' => $next,
            'partial' => $next !== null && count($records) < 50,
            'available' => is_readable(self::STORAGE . '/statistics.json'));
    }

    private function statistics()
    {
        $days = $this->dateRange();
        if (!$days) return array('state' => 'invalid');
        $data = $this->readJson(self::STORAGE . '/statistics.json');
        if (!$data) return array('state' => 'unavailable');
        $selected = array();
        foreach (array_reverse($days) as $day) if (isset($data['days'][$day])) {
            $selected[$day] = $data['days'][$day];
            unset($selected[$day]['recent_ids']);
        }
        return array('state' => 'ready', 'updated_at' => $data['updated_at'], 'days' => $selected);
    }

    private function diagnostics()
    {
        $snapshot = $this->readSnapshot();
        $version = isset($snapshot['collector_version']) ? $snapshot['collector_version'] : null;
        return array('state' => 'ready', 'module_version' => self::VERSION, 'collector_version' => $version,
            'required_collector_version' => self::COLLECTOR_VERSION,
            'compatible' => $version === self::COLLECTOR_VERSION, 'pbx_state' => $snapshot['state'],
            'updated_at' => isset($snapshot['updated_at']) ? $snapshot['updated_at'] : null,
            'snapshot_readable' => is_readable(self::SNAPSHOT),
            'journal_readable' => is_readable(self::STORAGE . '/statistics.json'),
            'journal' => isset($snapshot['journal']) ? $snapshot['journal'] : null,
            'runtime' => isset($snapshot['diagnostics']) ? $snapshot['diagnostics'] : null,
            'can_manage' => $this->canManage(), 'thresholds' => $this->thresholds(),
            'update_command' => $this->canManage() ? 'bash ' . escapeshellarg(__DIR__ . '/deploy/update-root.sh') : null);
    }

    private function rows($sql, $id)
    {
        $query = $this->freepbx->Database->prepare($sql);
        $query->execute(array($id));
        return $query->fetchAll(\PDO::FETCH_ASSOC);
    }

    private function extensionDetail($id)
    {
        $rows = $this->rows('SELECT extension, name, voicemail, ringtimer, outboundcid
            FROM users WHERE extension = ? LIMIT 1', $id);
        if (!$rows) {
            return array('state' => 'missing');
        }
        $devices = $this->rows('SELECT id, tech, dial, devicetype, description
            FROM devices WHERE user = ? ORDER BY id', $id);
        $deadline = microtime(true) + 2.0;
        $features = array();
        foreach (array('DND', 'CF', 'CFB', 'CFU', 'CW') as $family) {
            $features[$family] = $this->astdb($family, $id, $deadline);
        }
        $features['followme'] = $this->astdb('AMPUSER', $id . '/followme/ddial', $deadline);
        $features['followme_list'] = $features['followme'] === 'DIRECT'
            ? $this->astdb('AMPUSER', $id . '/followme/grplist', $deadline) : null;

        foreach ($devices as &$device) {
            $device['endpoint'] = array();
            if (preg_match('~\A(PJSIP|SIP)/([A-Za-z0-9_.+\-]+)(?:/[^\s]*)?\z~i', $device['dial'], $match)) {
                $device['endpoint'] = $this->sipDetail(strtolower($match[1]), $match[2], $deadline);
            }
        }
        unset($device);
        return array('state' => 'ready', 'entry' => $rows[0], 'devices' => $devices, 'features' => $features);
    }

    private function trunkDetail($id)
    {
        $rows = $this->rows('SELECT trunkid, name, tech, channelid, disabled, outcid,
            maxchans, dialoutprefix, usercontext, provider, `continue` FROM trunks WHERE trunkid = ? LIMIT 1', $id);
        if (!$rows) {
            return array('state' => 'missing');
        }
        $trunk = $rows[0];
        $routes = $this->rows('SELECT r.name FROM outbound_route_trunks t JOIN outbound_routes r ON r.route_id = t.route_id
            WHERE t.trunk_id = ? ORDER BY r.name', $id);
        $tech = strtolower($trunk['tech']);
        $endpoint = $this->sipDetail($tech, $trunk['channelid'], microtime(true) + 1.2);
        $settings = array();
        $registration = null;
        if ($tech === 'pjsip') {
            foreach ($this->rows("SELECT keyword, data FROM pjsip WHERE id = ?
                AND keyword IN ('sip_server', 'sip_server_port', 'registration')", $id) as $item) {
                $settings[$item['keyword']] = $item['data'];
            }
            if (!isset($settings['registration']) || $settings['registration'] === 'send') {
                $result = $this->ami('PJSIPShowRegistrationsOutbound', array(), 'OutboundRegistrationDetail',
                    'OutboundRegistrationDetailComplete', microtime(true) + 0.8);
                foreach ($result['items'] as $item) {
                    if (isset($item['ObjectName'], $item['Status']) && $item['ObjectName'] === $trunk['channelid']) {
                        $registration = $item['Status'];
                        break;
                    }
                }
            }
        }
        return array('state' => 'ready', 'entry' => $trunk, 'routes' => $routes, 'settings' => $settings,
            'endpoint' => $endpoint, 'registration' => $registration);
    }

    private function astdb($family, $key, $deadline)
    {
        $result = $this->ami('DBGet', array('Family' => $family, 'Key' => $key),
            'DBGetResponse', 'DBGetComplete', $deadline);
        if (isset($result['reply']['Message']) && $result['reply']['Message'] === 'Database entry not found') {
            return '';
        }
        return isset($result['items'][0]['Val']) ? $result['items'][0]['Val'] : null;
    }

    private function sipDetail($tech, $endpoint, $deadline)
    {
        if (!preg_match('/\A[A-Za-z0-9_.+\-]{1,190}\z/', $endpoint)) {
            return array();
        }
        if ($tech === 'pjsip') {
            $result = $this->ami('PJSIPShowEndpoint', array('Endpoint' => $endpoint),
                array('EndpointDetail', 'AorDetail'), 'EndpointDetailComplete', $deadline);
            $data = array();
            $aors = array();
            foreach ($result['items'] as $item) {
                if ($item['Event'] === 'EndpointDetail') {
                    $data = $item;
                } else {
                    $addresses = array();
                    if (isset($item['Contacts'])) {
                        foreach (explode(',', $item['Contacts']) as $contact) {
                            if (preg_match('~(?:^|/)sips?:([^\s<>]+)~i', trim($contact), $match)) {
                                $address = preg_replace('/^.*@/', '', $match[1]);
                                if (preg_match('/\A(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:[0-9]{1,5})?(?:[;?]|$)/i', $address, $host)) {
                                    $addresses[] = $host[1] . (isset($host[2]) ? $host[2] : '');
                                }
                            }
                        }
                    }
                    $aors[] = array('name' => isset($item['ObjectName']) ? $item['ObjectName'] : '',
                        'contacts' => array_values(array_unique($addresses)),
                        'registered' => isset($item['ContactsRegistered']) ? $item['ContactsRegistered'] : null,
                        'qualify' => isset($item['QualifyFrequency']) ? $item['QualifyFrequency'] : null);
                }
            }
            $fields = array('state' => 'DeviceState', 'transport' => 'Transport',
                'codecs' => 'Allow', 'context' => 'Context', 'aors' => 'Aors', 'direct_media' => 'DirectMedia',
                'dtmf' => 'DtmfMode', 'encryption' => 'MediaEncryption');
        } elseif ($tech === 'sip') {
            $result = $this->ami('SIPshowpeer', array('Peer' => $endpoint), '', '', $deadline);
            $data = isset($result['reply']['Response']) && $result['reply']['Response'] === 'Success'
                ? $result['reply'] : array();
            $fields = array('state' => 'Status', 'ip' => 'Address-IP', 'port' => 'Address-Port', 'codecs' => 'Codecs',
                'context' => 'Context', 'agent' => 'SIP-Useragent', 'direct_media' => 'SIP-DirectMedia',
                'dtmf' => 'SIP-DTMFmode', 'encryption' => 'SIP-Encryption');
        } else {
            return array();
        }
        $detail = array();
        foreach ($fields as $key => $field) {
            if (isset($data[$field]) && $data[$field] !== '') {
                $detail[$key] = $data[$field];
            }
        }
        if (!empty($aors)) {
            $detail['aor_details'] = $aors;
        }
        return $detail;
    }

    private function ami($action, array $headers, $item, $complete, $deadline)
    {
        $result = array('reply' => array(), 'items' => array());
        $astman = $this->freepbx->astman;
        if (!$astman || !$astman->connected() || microtime(true) >= $deadline) {
            return $result;
        }
        // Only fixed actions and validated arguments reach this AMI connection.
        $id = uniqid('calllive-', true);
        $message = "Action: $action\r\nActionID: $id\r\n";
        foreach ($headers as $name => $value) {
            $message .= "$name: $value\r\n";
        }
        $message .= "\r\n";
        if (fwrite($astman->socket, $message) !== strlen($message)) {
            return $result;
        }
        try {
            while (($remaining = $deadline - microtime(true)) > 0) {
                $micros = (int) ($remaining * 1000000);
                stream_set_timeout($astman->socket, (int) ($micros / 1000000), $micros % 1000000);
                $packet = $astman->wait_response(true, true);
                if (!$packet) {
                    break;
                }
                if (!isset($packet['ActionID']) || $packet['ActionID'] !== $id) {
                    continue;
                }
                if (isset($packet['Response'])) {
                    $result['reply'] = $packet;
                    if (!$complete || $packet['Response'] !== 'Success') {
                        break;
                    }
                } elseif (isset($packet['Event'])) {
                    if ($packet['Event'] === $complete) {
                        break;
                    }
                    if (in_array($packet['Event'], (array) $item, true)) {
                        $result['items'][] = $packet;
                    }
                }
            }
        } finally {
            if (is_resource($astman->socket)) {
                stream_set_timeout($astman->socket, 30);
            }
        }
        return $result;
    }

    private function readSnapshot()
    {
        $body = is_readable(self::SNAPSHOT)
            ? @file_get_contents(self::SNAPSHOT, false, null, 0, self::MAX_BYTES + 1) : false;
        $snapshot = is_string($body) && strlen($body) <= self::MAX_BYTES ? json_decode($body, true) : null;
        if (!is_array($snapshot) || !isset($snapshot['schema'], $snapshot['state'], $snapshot['updated_at'])
            || $snapshot['schema'] !== 1 || !is_int($snapshot['updated_at'])
            || abs(time() - $snapshot['updated_at']) > self::MAX_AGE) {
            return array('state' => 'collector_unavailable');
        }
        if ($snapshot['state'] !== 'ready') {
            return $snapshot;
        }
        if (!isset($snapshot['channels'], $snapshot['groups'], $snapshot['hints'])
            || !is_array($snapshot['channels']) || !is_array($snapshot['groups']) || !is_array($snapshot['hints'])) {
            return array('state' => 'collector_unavailable');
        }
        return $snapshot;
    }
}
