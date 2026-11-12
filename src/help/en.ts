// English version of the in-app usage guide (same sections, ids and icons as help.ts).

import type { HelpSection } from "../help";
import { icon } from "../icons";
import { esc } from "../ui";

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

export const SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "Getting started",
    icon: "Sparkles",
    body: `
      <p>BananaConn is a remote access tool that brings SSH, Telnet, serial (COM), SFTP, FTP/FTPS, RDP and VNC connections together in tabs.</p>
      <h4>Connect right away (Quick connect)</h4>
      <ol>
        <li>Pick a protocol (SSH, Telnet …) at the top left.</li>
        <li>Type <code>user@host:port</code> in the box next to it and press ${kbd("Enter")}. Examples: <code>root@10.0.0.5</code>, <code>admin@192.168.0.1:2222</code></li>
        <li>For serial, type <code>COM3</code> or <code>COM3:115200</code>.</li>
      </ol>
      <h4>Save it as a session</h4>
      <p>Save connection details with the ${icon("Plus", 13)} button in the session list (${kbd("Ctrl+Shift+N")}), then connect by double-clicking or pressing ${kbd("Enter")}. Connections saved in other programs can be moved over in one go with <a data-goto="import">Import</a>. In the session editor, <b>Test connection</b> checks before saving whether the host's port is open. Saved sessions can be tested from their right-click menu, and several sessions or a whole folder at once by selecting them or right-clicking the folder. In the results you can recheck only the failed sessions or copy the table, and double-clicking a row (or Enter on it) connects to that session.</p>
      <h4>Screen language</h4>
      <p><b>Language</b> at the top of Settings switches the screen to 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français or Deutsch (at once, without disconnecting; the guide and update notes follow it too). Until you choose, the app follows the Windows display language; once you choose, your choice always wins.</p>
      <h4>Finding a setting</h4>
      <p>Type a word into <b>Search settings</b> at the top left of the Settings dialog: matching settings from every page are listed, and picking one takes you to it.</p>`,
  },
  {
    id: "sessions",
    title: "Session list",
    icon: "Server",
    body: `
      <ul>
        <li><b>Folders</b>: In the session editor, write the folder with slashes, like <code>Prod/Web servers</code>, to create subfolders. You can also drag a session onto a folder to move it.</li>
        <li><b>Sorting and order</b>: The sort button above the session list chooses by name (AP2 before AP10), by address (IPs compared as numbers), recently connected, or custom. Drag a session above or below another to put it there; folders are reordered, or moved into another folder, the same way. Reordering switches to the custom order, which is kept. ${kbd("Alt+Up")} / ${kbd("Alt+Down")} move the selected session one place, and "Sort this folder by name/address" in a folder's menu tidies it in one go.</li>
        <li><b>Search</b>: Type part of a name, host, user or note into the search box at the top. ${kbd("Enter")} connects the only match; with several, it moves to the first one like ${kbd("Down")}, where ${kbd("Enter")} connects. ${kbd("Esc")} clears the search. If nothing matches and the search is an address (an IP, user@host:port and so on), ${kbd("Enter")} or "New session with this address…" opens a new session filled in with it.</li>
        <li><b>Session notes</b>: when a session has notes (warnings, where it is, who to call …) in its editor, its tabs (terminal, files, remote desktop, VNC, TFTP) show a notes button at the front of the toolbar: click it to read them while you work, and "Edit notes" to change them.</li>
        <li><b>Multi-select</b>: ${kbd("Ctrl")}+click to pick one at a time, ${kbd("Shift")}+click to pick a range. ${kbd("Shift+↑/↓")} and ${kbd("Ctrl+A")} also work. ${kbd("Esc")} clears the selection.</li>
        <li><b>Pin to home screen</b>: Right-click a session → Pin to home screen to keep it, by name, under "Pinned sessions" on the home screen shown when no tab is open. Unpin from the same menu, or right-click the session on the home screen to connect, edit, copy its address or unpin it. Several selected sessions can be pinned or unpinned at once, and pinned sessions come first in the command palette.</li>
        <li><b>Bulk actions</b>: With several selected, right-click → Bulk edit (${kbd("F2")}: user, port, credential, folder, key mode, jump host (SSH), SSH gateway (Telnet, RDP, VNC)), Move to folder, Copy addresses (one per line), Delete (${kbd("Del")}), Connect all (${kbd("Enter")}; more than 10 asks first). Right-click a folder → "Connect all N sessions in this folder" opens it and its subfolders in the order shown.</li>
        <li><b>Copy &amp; paste</b>: Select a session and press ${kbd("Ctrl+C")}, select a session in the target folder and press ${kbd("Ctrl+V")}. Each paste creates a new session named "Name (2)", "Name (3)". Right-click → Duplicate does the same.</li>
        <li><b>Edit</b>: ${kbd("F2")} or right-click → Edit. If a session with the same protocol, host, port and user already exists, its name is shown under Host (saving is not blocked).</li>
      </ul>`,
  },
  {
    id: "import",
    title: "Import from other programs",
    icon: "Download",
    body: `
      <p>Choose from the ${icon("Download", 13)} button above the session list. A preview list is shown before importing, and existing sessions are skipped. <b>Passwords are not imported</b> (each program encrypts them with its own key). Enter them on first connect or assign one from the credential vault. Sessions that logged in with a public key are linked to their key files in the credential vault, and key files that cannot be found or used are listed before importing.</p>
      <table class="help-table">
        <tr><th>Program</th><th>What to choose</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (portable: next to the executable)</td></tr>
        <tr><td>SecureCRT</td><td>Session folder <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (including folder structure, log file names, auto-logging settings and the key files used for public-key login, and a firewall that goes through another session as a jump host, session descriptions as notes, and an SSH session's NO-OP interval as its keepalive interval), or an XML made with File → Export Settings</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (if full-file encryption is on, turn it off and save first)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>Reads this PC's settings directly (including each session's key file, port forwards, agent forwarding, compression and keepalive interval)</td></tr>
        <tr><td>WinSCP</td><td>This PC's settings, or <code>WinSCP.ini</code> if none (including key files)</td></tr>
        <tr><td>Xshell</td><td>The <code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code> folder. Keys kept in Xshell's key store cannot be linked: export them in OpenSSH format from Xshell's User Key Manager and set them in the credential vault</td></tr>
        <tr><td>OpenSSH</td><td>The <code>.ssh\\config</code> file (Host, HostName, User, Port, ProxyJump, IdentityFile, LocalForward, RemoteForward, DynamicForward, ForwardAgent, Compression, ServerAliveInterval; as ssh does, every matching Host block applies and the first value wins, while port forwards from all of them add up; wildcards such as <code>Host *</code> only supply defaults, not sessions)</td></tr>
        <tr><td>RDCMan</td><td><code>.rdg</code> file</td></tr>
        <tr><td>Remote Desktop</td><td>A folder containing <code>.rdp</code> files (subfolders included)</td></tr>
        <tr><td>CSV</td><td>Column names on the first line: Name, Protocol, Host, Port, Username, Folder, Domain (comma, semicolon or tab separated). <b>Export session list (CSV)</b> in the same menu writes this format.</td></tr>
      </table>
      <p>Between BananaConn installs, use <b>Export/Import session backup (JSON)</b> in the same menu. Backups contain your sessions plus empty folders, snippets/macros and SSH tunnels. Restoring on the same PC keeps the links to credentials, and even if every session already exists you can restore just the missing folders, snippets and tunnels. SSH tunnels and security-related options (ignore certificate errors, port forwarding, log file location, etc.) are imported only when "Also import security-related options" is turned on.</p>`,
  },
  {
    id: "tabs",
    title: "Tabs and split view",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>Close a tab</b>: ${kbd("Ctrl+F4")} or ${kbd("Ctrl+Shift+W")}, or middle-click the tab. Press ${kbd("Enter")} in the confirmation to close; check "Don't ask again" to skip it next time (can be turned back on in Settings).</li>
        <li><b>Open the same session again</b>: <b>Double-click</b> the tab. Handy for a second connection to the same device for monitoring.</li>
        <li><b>Tab menu</b>: Right-click a tab to reconnect, edit its session (save a quick connection as a session), copy its address (user@host:port), rename the tab (kept until it is closed; empty for the original name), close the other tabs or close the tabs to the right.</li>
        <li><b>Switch tabs</b>: ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. With many tabs, scroll the mouse wheel over the tab bar to move left and right. Drag tabs to reorder them. Type a tab's name or address in the command palette (${kbd("Ctrl+K")}) to jump to a tab that is already open. The palette also lists recently closed tabs to open again, and clicking "N tab(s)" in the status bar opens it too.</li>
        <li><b>Split view</b>: The single / left-right / top-bottom / 4-way buttons at the top. Drag a tab into the pane you want.</li>
        <li>The tab dot color shows the protocol, blinking means connecting, and red means an error.</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "Terminal (SSH · Telnet · Serial)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>Copy &amp; paste</b>: Selecting by dragging copies immediately, and right-click pastes (configurable in Settings). ${kbd("Ctrl+C")} copies only when there is a selection; otherwise it is sent to the device. With that turned off, right-click opens a menu with Copy, Paste, Select all, Find and Clear screen. The last 30 things you copied can be picked again from "Clipboard history" in the command palette; words typed in its filter keep only the matching entries, and Enter copies the first (anything that looks like a password is not kept).</li>
        <li><b>IP addresses in the output</b>: IPv4 addresses in terminal output (show arp, show ip int brief, ip route, traceroute …) work like links: ${kbd("Ctrl")}+click (or click, per Settings) opens a menu to start a new session for that address (the editor opens filled in; nothing connects until you save), open the network tools (ping, ports, DNS) or copy the address. Netmasks (255.x.x.x) and 0.0.0.0 are left out. Subnet calculator in the menu shows the address's network, broadcast, usable range, host count and masks, using the prefix written right after it (/24, a netmask such as 255.255.255.0 or 0xffffff00, or an ACL wildcard such as 0.0.0.255) when there is one. MAC addresses (aa:bb:cc:dd:ee:ff, aabb.ccdd.eeff …) work the same way: copy one in Linux, Windows, Cisco or Huawei notation, or use "Find this MAC in any notation" to find it on screen however it is written.</li>
        <li><b>Jump between commands</b>: Each command entered at the prompt is remembered by its line, so in long output ${kbd("Ctrl+Shift+↑")} / ${kbd("Ctrl+Shift+↓")} scroll straight to the line of the previous or next command and briefly highlight it. Going past the last command returns to the end of the output. Nothing is remembered inside full-screen programs such as vi or less, and what was typed is not stored. A command that took more than 2 seconds gets its time (⏱ 12.4s) at the right end of its line once the prompt is back. ${kbd("Ctrl+Shift+O")} copies just the output of the last command (or of the one jumped to this way), with no long drag to select it; a command still running gives its output so far. "Compare with the previous run" in the right-click menu opens the comparison window with this output against the output of the same command typed earlier at the same prompt (a show before and after a change, for example). Only output still in the terminal is searched; a shortcut can be set in Settings.</li>
        <li><b>Compare output</b>: Select some output and press ${kbd("Ctrl+Shift+D")} to take it as the first part; select in another tab (or another part of the same tab) and press it again to compare the two line by line, as when setting two switches' configurations or a show output before and after a change side by side. Added lines are green, removed ones red, unchanged runs are folded, and whitespace differences can be ignored. "Compare output" in the command palette (${kbd("Ctrl+K")}) opens an empty comparison to paste into. It all happens in this window; nothing is sent to the device. "File…" above either side loads a text file, such as a saved configuration backup, to compare with the current output; "Swap sides" exchanges the two. "Copy result" copies the differences as text with +/- marks, ready for a change record.</li>
        <li><b>Copy as table</b>: select a table such as show ip interface brief, show mac address-table or df -h from its header line and press ${kbd("Ctrl+Shift+X")}: it is copied split into columns where the header's words are, tab-separated, so pasted into Excel each value lands in its own cell. Whole lines are taken, columns stay aligned with wide characters, and values starting with = or - get a leading ' so they are not run as formulas.</li>
        <li><b>Repeat a command</b>: "Repeat command…" in the toolbar's snippet menu sends the same command (e.g. show interface counters) again at the interval (seconds) and number of times you set — for watching values change on network gear that has no watch. Each run goes out only after the previous output has ended and the same prompt is back; typing in this tab, a disconnect, a login or password prompt, a pager (--More--) or a different prompt stops it at once. A command matched by a risky-command rule cannot be repeated.</li>
        <li><b>Work timer</b>: "Work timer…" in the toolbar snippet menu or the right-click menu takes a time in minutes and a note (e.g. type reload cancel). The tab shows the time left, and a sound and a notification (a Windows notification when the app is in the background) come one minute before and at the end. Use it for work that must be cancelled or confirmed in time, such as <code>reload in 10</code> or <code>commit confirmed 10</code>. It sends nothing, keeps running if the connection drops, and closing a tab with a timer asks first. An ended timer stays on the tab as 0:00 until you press a key or click in that tab, and the taskbar button flashes when the app is in the background. Entering <code>reload in 10</code> or <code>commit confirmed</code> at a prompt offers a timer with the time and note filled in, and entering <code>reload cancel</code> or <code>commit</code> while a timer runs offers to stop it (it only offers; nothing starts or stops by itself). A number after <code>commit confirmed</code> is read as minutes only on a device recognised as Junos.</li>
        <li><b>Links</b>: ${kbd("Ctrl")}+click an address in the output to open it in the browser (a plain click is for selection and focus). Settings → Terminal can make a plain click open links.</li>
        <li><b>Font size</b>: ${kbd("Ctrl")}+mouse wheel, or ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)} in the toolbar.</li>
        <li><b>Find</b>: ${kbd("Ctrl+Shift+F")}. The list button in the find bar (or ${kbd("Alt+Enter")}) gathers every matching line: read just those lines of a long output, or "Copy all", without running the command again with "| include" on the device; click a line to go to it in the terminal. The case and regex settings apply. "In every terminal tab" in that list searches every open terminal tab and groups the lines by tab; click a line to go to it in its tab. The menu of a MAC or IP address in the output has "Find in every terminal tab" too: after sending the same command to several switches, see at once which device's MAC or ARP table holds the address (a MAC in any notation; an IP only as a whole address, not part of a longer one).</li>
        <li><b>When a line arrived</b>: right-click in the terminal and the bottom of the menu shows when the line under the pointer arrived (click to copy). Use it to see when a device console message or a ping reply that prints no time came in. It is to the second, with the date when not today. A line redrawn in place (a progress bar) shows when it first appeared; there is none inside full-screen programs such as vi or less, or for lines from before the screen was cleared (with "Right-click to paste" on, the menu does not open).</li>
        <li><b>Key mode</b>: If Delete, Home or End print <code>~</code> on devices such as Cisco IOS, switch the toolbar to "Keys: device" (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). You can set the default in the session editor.</li>
        <li><b>Serial</b>: In the session editor, set the COM port ("Find ports"), speed, parity and flow control. Break in the toolbar sends a Break signal. A multi-line paste, or a configuration sent with Send a text file in the toolbar, goes one line at a time: each line is sent as soon as the device has taken the previous one and shown its prompt again, so fast devices get it quickly and slow ones drop no characters. Progress is shown while sending; ${kbd("Ctrl+C")}, Break or Stop in the progress box drops the remaining lines. For devices that do not echo input, choose fixed delays in Settings → Terminal. Telnet sessions through a console server work the same way when "Console-server connection" is on in the session editor. On Telnet sessions the toolbar's Break sends the Telnet Break command, which a console server passes to the device's port as a Break signal. When a USB serial adapter is unplugged, the tab waits for the port and reconnects as soon as it is plugged back in. Port I/O uses a fast mode in which keystrokes never wait for a pending read; should a driver misbehave, switch to compatibility mode in Settings → Terminal.</li>
        <li><b>Several lines to a console waiting for a login</b>: while lines go one at a time to a device console, the paste stops if the device asks for a login name (a console logged out after its idle time and woken by the first line, for example), so the rest does not go in as a user name and a password and fail the login; log in and send it again. It also stops at a password question (sudo and su included), except when the device asks for one on the very line after <code>enable</code> was sent at its own &gt; prompt (enable pasted together with its password). If enable asks for no password (privileged already, or none set), the next line that looks like one is skipped, with a note, rather than sent as a command: as a command the device would look it up as a host name, showing the password on the network and in logs. The next line goes once the device's prompt is back. It also goes on when the device asks a question (<code>[confirm]</code>, <code>(yes/no)?</code> and the like) or takes text in, as for a banner; at a console that logged out ("Press RETURN to get started"), at a pager such as <code>--More--</code>, or when the prompt has not come back for 60 seconds, the paste stops and the rest is not sent. A multi-line paste or snippet to a tab not logged in yet, or to a console waiting at "Press RETURN to get started", asks first, and several lines are never sent to a login, password or host-key question.</li>
        <li><b>Output keyword highlighting</b>: ERROR·FAIL in red, WARN in yellow, OK·SUCCESS in green.</li>
        <li><b>Rendering</b> (Settings → Terminal): "Auto" draws with the GPU (WebGL) on PCs with a graphics card, speeding up heavy output, and uses the standard renderer on servers and remote sessions without one. Only terminals visible on screen use the GPU.</li>
        <li><b>Snippets &amp; macros</b>: Save frequently used commands under Snippets in the toolbar, and use "Record" to capture input and play it back.</li>
        <li><b>Files</b> (SSH): The Files button in the toolbar opens an SFTP pane for the same server alongside.</li>
        <li><b>Automatic reconnect</b> (can be turned off in Settings): when a logged-in SSH or Telnet session drops, it waits a moment and reconnects, waiting longer each time it keeps failing. A connection whose login failed, or that ended during login, is not reconnected: connecting again and again with a wrong password can get the server to block you. Fixing the login with <b>Edit session</b> in the login-failed dialog reconnects that tab at once, and a reconnect always uses the session's latest saved settings.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "Broadcast input",
    icon: "Radio",
    body: `
      <p>Turn on <b>Broadcast input</b> at the top and keys typed in the current terminal also go to the other connected terminal tabs (tabs not on screen too). Which tabs receive is decided per line by the rules below, and their tab dots turn yellow. Use it to enter the same commands on several devices, and turn it off when done. Each tab sends Delete, Home and End in its own key mode (standard/device).</p>
      <p>Broadcast goes only between tabs whose cursor is at the same kind of line when a line is started: a logged-in shell, before the login, a user name question, a password question (enable and sudo too) or a host key question. The receiving tabs are fixed then and kept until the Enter (turned on, broadcast starts with the next line), and a tab whose line has turned into another kind by the time the Enter arrives (a console back at its login question) does not get the Enter. This keeps commands from landing as passwords in a reconnected tab (each a failed login) and passwords from appearing in another tab's shell. A choice a command asks ([y/N], [confirm] and the like) is a kind of its own too, so an answer goes only to tabs at the same question, and tabs before their login exchange only the Enter or Ctrl+C that wakes a device. A tab that the output moves to another kind of line while a line is being typed (a password question, a prompt after a timeout) gets none of the rest of that line, and a multi-line paste or snippet is never sent to a login or password question.</p>
      <p>To send to some tabs only, right-click the others and choose <b>Leave out of broadcast</b>. A tab left out neither receives nor sends broadcast input, and while broadcast is on its dot shows as a hollow circle. <b>Put back into broadcast</b> in the same menu undoes it (kept until the tab is closed).</p>`,
  },
  {
    id: "log",
    title: "Session logging",
    icon: "ScrollText",
    body: `
      <p>Start and stop with the <b>Log</b> button in the toolbar. When starting you can check and edit the file name (can be turned off in Settings), and clicking "Logging" in the status bar opens the folder containing the file.</p>
      <h4>File name substitutions (same as SecureCRT)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> session name</td><td><code>%H</code> host</td><td><code>%U</code> user</td><td><code>%P</code> port</td></tr>
        <tr><td><code>%Y</code> year (4 digits)</td><td><code>%M</code> month</td><td><code>%D</code> day</td><td><code>%%</code> % sign</td></tr>
        <tr><td><code>%h</code> hour</td><td><code>%m</code> minute</td><td><code>%s</code> second</td><td><code>%t</code> millisecond</td></tr>
      </table>
      <p>Example: <code>D:\\Checks\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\Checks\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>. Missing folders are created. Relative paths are under Documents\\BananaConn\\logs.</p>
      <ul>
        <li><b>If the file exists</b>: Append / Overwrite / New file (-2, -3 …).</li>
        <li><b>Prefix each line</b>: e.g. <code>[%h:%m:%s] </code> to timestamp every line.</li>
        <li><b>On start / on stop</b>: Text to write to the file (substitutions allowed).</li>
        <li><b>New file after midnight</b>: If the name contains <code>%D</code>, logging continues in a new file when the date changes.</li>
        <li><b>Log automatically on connect</b>: For all sessions (Settings → Log) or per session (session editor → Log → This session only).</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "Snippets · Macros",
    icon: "Circle",
    body: `
      <p>Save frequently used commands (snippets), or record the keys you type in a terminal and send them again exactly (macros).</p>
      <p><b>Built-in snippets per OS</b>: common read-only checks (commands that change nothing) for Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS · NX-OS · ASA, FortiGate, Aruba, Juniper and Huawei, and for telephone systems (PBX): Avaya CM, Cisco CUCM, Cisco CME·CUBE and Asterisk·FreePBX. The snippet list shows your own snippets and those for the OS recognised in that tab first; other systems are one click away under "… snippets". Edit or delete them, or change their OS group, in Manage snippets.</p>
      <p><b>Risky commands</b>: every line a snippet or macro sends is checked against the rules in Settings → Risky commands. Commands that change the time or NTP (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) are <b>blocked</b> and never sent; commands such as reboots, deletions, formatting or device configuration changes need confirmation in a <b>warning</b> first. When sent, the tab's log is turned on, and every attempt, cancellation and block is recorded in <code>risky-commands.log</code> in the logs folder. Commands chained with <code>;</code> or <code>&amp;&amp;</code>, commands inside <code>sudo</code>, <code>su -c</code>, <code>bash -c</code> or <code>eval</code>, and lines continued with a trailing <code>\\</code> are checked too. Macros containing Tab completion or cursor keys (←→, Home, history ↑↓) get a warning, because the command actually sent cannot be known. Commands you type yourself are checked too: when you press Enter, the command line shown on the screen is matched against the same rules (including history ↑↓ and Tab completion). Full-screen programs such as vi or less are not checked, and the check can be turned off in Settings → Risky commands.</p>
      <p><b>Colours and suggestions while typing</b>: the command typed after the prompt is coloured by commands, options, strings, paths and operators, and turns red before Enter when a risky-command rule matches. The rest of a command is suggested in grey from the commands run before (kept on this PC only) and from snippets: <kbd>→</kbd> or <kbd>End</kbd> types all of it, <kbd>Ctrl</kbd>+<kbd>→</kbd> one word at a time. <kbd>Tab</kbd> stays the server's own completion. <kbd>Ctrl</kbd>+<kbd>Space</kbd> opens a list of candidates (↑↓ to pick, Enter or Tab to type it, Esc to close). Candidates come from your history, snippets, a command dictionary for the recognised device (Linux, AIX, HP-UX, Solaris, Windows, Cisco, FortiGate, Aruba, Juniper, Huawei) and, on Unix servers with the resource monitor on, the program names on the server's PATH. Those names are read once over the monitor's connection; nothing is typed into the terminal. The command line is read from the screen, so passwords, which are not shown, are never recorded, and risky commands and commands holding a password or token (<code>mysql -p…</code>, <code>--password=…</code>, <code>TOKEN=…</code>) are neither recorded nor suggested; <kbd>Shift</kbd>+<kbd>Delete</kbd> in the candidates list removes a mistyped entry. Both can be turned off in Settings → Terminal, where the command history can also be cleared.</p>
      <p><b>ls colours</b>: on servers whose ls has no colours, such as AIX, HP-UX and Solaris, folders (blue), programs (green), links (cyan) and archives (red) are coloured as on Linux. ls -l and ls -F are read from their output; for a plain ls the folder is read separately over the resource monitor's connection (when the prompt shows the path). Nothing is sent to the terminal, and a listing the server coloured itself is left alone. Turn it off in Settings → Terminal.</p>
      <h4>Create and send snippets</h4>
      <ol>
        <li>In the terminal toolbar: <b>Snippets</b> → <b>Manage snippets…</b> → <b>New snippet</b>.</li>
        <li>Enter a name and the content to send. Multiple lines are sent one at a time with Enter (e.g. <code>terminal length 0</code> followed by <code>show running-config</code> on the next line).</li>
        <li>With <b>Press Enter after sending</b> on, the last line runs right away; with it off, the command is only typed and waits.</li>
        <li>To send one, click <b>Snippets</b> in the toolbar and pick it from the list.</li>
        <li>Write a value that changes each time as <code>{{?name}}</code> (e.g. <code>show interface {{?interface}}</code>, <code>ping {{?target}} repeat {{?count=100}}</code>). Sending opens a box that asks for the values and previews exactly what goes out. What follows <code>=</code> is the default, and a name used twice is asked once. The values typed last are remembered until the app closes.</li>
      </ol>
      <h4>Record and play macros</h4>
      <ol>
        <li>Click <b>Record</b> in the terminal toolbar; the button changes to <b>Stop recording</b> and every key you type from then on is saved as-is (including Enter, Tab, Ctrl keys, arrow keys and IME input).</li>
        <li>Type commands on the device as usual. Snippets you send are recorded into the macro too.</li>
        <li>Click <b>Stop recording</b> and give it a name to save.</li>
        <li>To replay, pick the item marked <b>Macro</b> from the <b>Snippets</b> list in the toolbar. The recorded keys are sent in order, exactly as typed.</li>
      </ol>
      <ul>
        <li><b>Many devices at once</b>: Send a snippet or macro while <b>Broadcast input</b> is on at the top and it also goes to the other terminal tabs at the same kind of line (a shell, a login question and so on).</li>
        <li><b>Don't record passwords</b>: Macros store keys exactly as typed, so a password entered while recording is saved too.</li>
        <li>You can view macro contents in <b>Manage snippets…</b> (⏎ = Enter, ⇥ = Tab, ^C = Ctrl+C). Renaming and deleting work, but the keys cannot be edited; record it again to change it.</li>
        <li>Snippets and macros are stored on this PC and shared by all sessions.</li>
      </ul>`,
  },
  {
    id: "ai",
    title: "AI (commands · explanations · chat · analysis)",
    icon: "Sparkles",
    body: `
      <p>Connect a cloud AI (API key), a subscription CLI or a local LLM on this PC to help with terminal work. Add services and pick the default one in Settings → AI.</p>
      <ul>
        <li><b>Ways to connect</b>: API keys (Anthropic Claude, OpenAI, Google Gemini, OpenAI-compatible servers), subscription CLIs (Claude Code, Codex CLI, Gemini CLI: install one on this PC and sign in once, and it answers with your subscription), local LLMs (Ollama, or OpenAI-compatible servers such as LM Studio, llama.cpp and vLLM). API keys are stored in the credential vault; "Load list" fetches the models and "Test connection" tries the service.</li>
        <li><b>Make a command</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>): describe a task and get one command for the recognised device or OS. Press Enter again to put it on the input line (it is not run); you run it yourself with Enter. The risky-command rules apply: blocked commands (time or NTP changes and the like) are not even put on the line.</li>
        <li><b>Explain output</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>): explains the selected text (or the latest output on the screen): what it means, the likely cause and next steps.</li>
        <li><b>AI chat</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>): opens a conversation beside the terminal. "Attach selection" sends output along; each command line in an answer has a button that puts it on the input line. Drag the panel's left edge to change its width (kept for every tab); double-click it for the default width. Conversation text can be selected and copied; each message has a copy button, and "Copy the whole conversation" at the top and the right-click menu copy too.</li>
        <li><b>The AI runs commands</b>: describe a task in the AI chat and the AI runs commands in this terminal one at a time, reads the results and analyses them. Every run is visible on the screen and recorded in <code>risky-commands.log</code>. Read-only commands (<code>df</code>, <code>free</code>, <code>systemctl status</code>, <code>show …</code>, <code>display …</code> …) run at once; commands that could change the system wait for your Run or Skip. Commands a block rule matches (time or NTP changes and the like) never run. At most 8 commands per question, each stopped with Ctrl+C after 30 seconds. The button under the chat switches to "ask before every command" or "never run".</li>
        <li><b>Configuration and log analysis</b>: the file button in the chat reviews a configuration (security problems, risky settings) or analyses a log (errors, anomalies). On network devices, device button → "Review configuration with AI" checks the running-config directly.</li>
        <li><b>What is sent</b>: before anything goes to a cloud AI you see exactly what will be sent and confirm it ("Don't ask again" holds for that conversation). Passwords, keys and tokens (<code>password=…</code>, <code>-p…</code>, <code>enable secret</code>, <code>snmp-server community</code>, private keys …) are always hidden; turn on the setting to also replace IP addresses and host names with IP_1, HOST_1 …, shown with their real values again in the answer. A local LLM never leaves this PC, so it is neither previewed nor masked. Check your company's security policy before sending device information to an outside AI.</li>
        <li>Subscription CLIs: Claude Code runs with all tools off (no commands, no file reading) in an empty folder, Codex in a read-only sandbox. The app never handles your sign-in.</li>
        <li><b>Attachments and remote desktops</b>: attach images, PDFs and text files with the 📎 button, by dropping them on the chat, or with <kbd>Ctrl</kbd>+<kbd>V</kbd> (screenshots). Text files become part of the message and are masked; images and PDFs cannot be masked and are shown as they are in the preview. Large images are scaled down. Most services take images; PDFs go to the Claude, Gemini and OpenAI APIs and Claude Code. In RDP and VNC, the toolbar's "AI" captures the remote screen to explain it or attach it to the chat. The AI runs no commands in a remote desktop; copy a command from the answer and paste it on the remote screen.</li>
        <li><b>AI on an RDP or VNC PC</b>: the toolbar's "AI" → "Connect over SSH so the AI can run commands…" shows one line. On the remote screen paste it into Win+R (Run), press Enter and choose "Yes" for administrator rights; the rest is automatic. If OpenSSH is missing, this PC sends it to the remote PC (downloaded once from github.com/PowerShell/Win32-OpenSSH and kept), so a Windows 7 PC without internet works too. The service is started, port 22 is allowed for every network profile and PowerShell becomes the SSH shell; the progress shows in the app, and at the end an SSH session with the same host, account and folder opens (an existing one is reused). If the remote PC cannot get the files from this PC, allow BananaConn in this PC's Windows Firewall. There the AI runs read-only PowerShell commands such as Get-*, ipconfig and systeminfo at once and asks before anything that could change the PC. The VNC menu also shows the command that turns on the SSH server of a Linux or Unix PC (the VNC password is not used for the SSH login).</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "Device detection · CPU · Memory",
    icon: "Activity",
    body: `
      <p>When you connect over SSH or Telnet, a separate monitoring connection detects the device type automatically and shows the device name and CPU/memory (plus disk for servers) in the status bar. Nothing is typed into the terminal.</p>
      <p>Supported devices: <b>Cisco</b> IOS · IOS-XE · NX-OS · ASA, <b>Fortinet</b> FortiGate, <b>Aruba</b> AOS-CX · AOS-Switch (ProCurve) · wireless controllers, <b>Juniper</b> Junos, <b>Huawei</b> VRP, and servers running <b>Linux (Red Hat etc.)</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b>.</p>
      <ul>
        <li><b>Device button</b>: Once detected, a button with the device name appears in the terminal toolbar. Click it to enter common show commands for that device (interfaces, routing, VLAN, HA, error logs, etc.) in one go. No configuration-changing commands are included.</li>
        <li><b>Back up config</b>: For network devices, device button → "Back up config" saves the running-config (<code>show</code> on FortiGate) to a <code>devicename_datetime.cfg</code> file. It reads over the monitoring connection, so it does not disturb the terminal you are working in. Nothing is saved if the device refuses (for lack of privileges) or the end of the configuration (<code>end</code> on IOS, <code>return</code> on Huawei, etc.) never arrives.</li>
        <li><b>Configuration compare</b>: Device button → "Compare the configuration with a backup file…" reads the device's configuration as it is now and shows it beside the backup file you pick in the comparison window (back up before a change to see what the change did). The backup last saved or compared for each device is offered first (remembered on this PC only).</li>
        <li><b>Automatic key mode</b>: When a network device is detected, sessions with no key mode chosen yet switch to device mode (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E).</li>
        <li><b>Top processes</b>: Click CPU/memory in the status bar to see the top 10 processes by CPU and memory use and the disk list (Linux).</li>
        <li>Monitoring uses one additional login. <b>Even with several tabs open to the same device, only one monitoring connection is used</b> (to save the device's VTY lines).</li>
        <li>Polling runs every 2 seconds on Linux (10 seconds over Telnet), 15 seconds on network devices and 10 seconds on AIX/HP-UX/Solaris. Monitoring commands do not show up in the server's shell history (<code>~/.sh_history</code> etc.). It pauses when no tab for that device is on screen or the window is minimized (devices are checked only once every 5 minutes so the login doesn't drop), and reads immediately when shown again.</li>
        <li>If "Click to log in" appears, click it and enter the password for monitoring (not saved). If the password is not known, the monitoring connection hangs up before sending the user name, so no failed login is recorded on the device. For a Telnet device you enter without a password, leave the password empty and start. If the device asks for something after login, such as a one-time code, monitoring does not run. To turn it off: Settings → Session.</li>
      </ul>`,
  },
  {
    id: "files",
    title: "File transfer (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>The left side is your PC and the right side is the server. Drag items to the other side or click the transfer button. Folders are sent with their contents.</li>
        <li>If a file with the same name exists, you are asked whether to overwrite. Transfers show progress and can be cancelled.</li>
        <li><b>TFTP</b>: Choose TFTP as the session type (or in Quick connect) to open a TFTP tab. TFTP has no login or folder listing, so type the <b>file name on the server</b> and click "Get", or pick a file on your PC and click "Send". Block size "Auto" suits most devices, and old servers that don't understand options automatically fall back to 512. To let a device send files to your PC (e.g. <code>copy running-config tftp:</code>), turn on the <b>TFTP server</b> under the "Servers" button at the top.</li>
        <li>Sending a folder over SFTP transfers 4 files at once, which is much faster for folders with many small files, especially over long distances. FTP sends one at a time because of server connection limits, but you can keep browsing folders during the transfer.</li>
        <li><b>Keyboard</b>: Click the list once, then ${kbd("↑")}/${kbd("↓")}, ${kbd("Home")}/${kbd("End")} pick an item (${kbd("Shift")} extends the selection); ${kbd("Enter")} opens, ${kbd("F2")} renames, ${kbd("Del")} deletes, ${kbd("F5")} refreshes, ${kbd("Backspace")} goes up a folder and ${kbd("Ctrl+A")} selects all. Go back and forward through the folders you visited with ${kbd("Alt+←")}/${kbd("Alt+→")}, the mouse's back and forward buttons, or the ← and → buttons above the path.</li>
        <li>Double-click a text file on the server to open it in the built-in editor; saving writes it straight back to the server. Right-click an empty spot on the server side → "New file" to create an empty file and edit it at once (nothing is created if the name is taken).</li>
        <li><b>Permissions</b> (SFTP): right-click an item on the server side → "Change permissions…" and tick read, write and execute for owner, group and others, or type an octal mode (e.g. 755). Three digits leave the setuid, setgid and sticky bits as they are; four (4755, 0755) set them too. Several selected items all get the same mode; items inside a folder are not changed. The permissions column shows the special bits as ls does (s, t).</li>
        <li><b>Bookmarked folders</b>: the star in the server-side path bar bookmarks the folder shown (or removes it) and lists the bookmarks to jump to. They are kept on this PC per server (user, address, port), so a saved session, a quick connection and an SSH tab's SFTP pane to the same server share them.</li>
        <li><b>Compare files</b>: right-click a file → "Compare the two selected files" (with two chosen in one pane) opens the comparison window. For one file in each pane (a configuration backup and the current one on the server, say), choose "Take for comparison" on one and "Compare with what was taken" on the other. What was taken with Compare selection in a terminal can be compared too. Only text files of 5MB or less are compared.</li>
        <li><b>Go to a folder in the terminal</b>: in an SFTP pane opened beside an SSH tab, right-click a server folder (or an empty spot) → "Go to this folder in the terminal (cd)" sends <code>cd 'path'</code> to the terminal beside it. It is sent only at a command prompt with nothing typed, and never to a device that is not a Linux or Unix shell.</li>
        <li><b>Logging in with a key</b> (SFTP, resource monitor, SSH gateway): for a key with a passphrase that is not in the vault you are asked for the passphrase, and can save it with the key. The passphrase only opens the key on this PC and is never sent to the server. If the server refuses the key, you are asked for a password, which is then used instead of the key.</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "Remote Desktop (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>Screen size</b>: If the session resolution is "Auto", it matches the tab size. Resizing the window resizes the remote resolution too, and if the server doesn't support live resizing it reconnects automatically at the new size.</li>
        <li><b>Fit</b>: Choose whether to scale the remote screen to fit the tab (on) or view it at actual size (off).</li>
        <li><b>Copy &amp; paste</b>: Like mstsc, exchange text, images and <b>files and folders</b> between your PC and the remote PC with ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")} (session option "Share clipboard"). Files copied on the remote side are downloaded when you paste, with progress shown in the toolbar.</li>
        <li>Keyboard: Your PC's keyboard type and layout (e.g. Korean 103/106-key) are passed to the remote side as-is, so right Shift/Ctrl/Alt and the Hangul/Hanja keys behave as in mstsc. The Num Lock and Caps Lock state is matched on the server too, so the number pad types at the logon screen without pressing Num Lock again.</li>
        <li>Toolbar: Send ${kbd("Ctrl+Alt+Del")}, Windows key, Type clipboard (send clipboard text as keystrokes), Open in mstsc.</li>
        <li>On first connect you verify the server certificate fingerprint; once trusted, you won't be asked again.</li>
        <li>While you are viewing another tab or the window is minimized, that RDP tab stops drawing, and fetches the full screen at once when you return.</li>
        <li><b>VNC speed</b>: Under "Quality" in the toolbar, choose Fast (default: lower color/quality, maximum compression), Normal or Sharp (applied immediately without disconnecting). Turn on "Status" to see the encoding the server uses and the data received per second. If only Raw or Hextile appear, the server is not using compression.</li>
        <li>When VNC is slow, the cause is usually the <b>server settings</b>. For TightVNC Server: in server settings → Server tab, reduce the <b>Screen polling cycle</b> from 1000ms to 30–50ms, turn off <b>Grab transparent windows</b>, and enable the <b>mirror driver (DFMirage)</b> if installed. Removing the desktop wallpaper also helps a lot. On large screens such as 4K, TightVNC may fall tens of seconds behind (measured on one PC: TightVNC 34–46 s behind, UltraVNC near real time). Use <b>UltraVNC Server</b> then, with Windows desktop duplication (DDengine) turned on in its Capture tab.</li>
        <li><b>VNC file transfer</b>: the VNC protocol itself has no file transfer (TightVNC and UltraVNC each use their own extension). The toolbar's "File transfer" opens an SFTP file pane to the same PC beside the screen. The remote PC needs an SSH server; if it is off, the script under "AI" → "Connect over SSH so the AI can run commands…" turns it on.</li>
        <li>The built-in RDP does not use mstsc's graphics acceleration (H.264), so it can be slower than mstsc when the screen changes a lot. In that case use "Open in mstsc".</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "Tools · File servers",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>SSH gateway</b>: In the RDP, VNC or Telnet session editor, choose a saved SSH session as the gateway to reach devices behind a firewall through that server.</li>
        <li><b>Proxy</b>: Under "Proxy" in the session editor, choose SOCKS 4/4a, SOCKS 5, HTTP CONNECT, Telnet (connect with a command) or a local command, as in PuTTY's Connection → Proxy. SSH, SFTP, Telnet, FTP/FTPS, RDP and VNC, and the session's resource monitor, all go through it. Pick the proxy login from the credential vault, and set the hosts that skip the proxy (*.corp.local, 10.0.0.0/8), where names are looked up, and whether diagnostics are shown. FTP uses passive mode through a proxy. Sessions imported from PuTTY or KiTTY bring their proxy settings along (without the password).</li>
        <li><b>SSH tunnels</b>: Tools at the top → SSH tunnels. Save forwardings of local port → SSH server → target address and turn them on and off. Clicking a tunnel's "127.0.0.1:port" in the list copies it, ready to paste into a browser or a database client. A running tunnel to port 80, 8080, 443 or 8443 has an "Open in browser" button that opens the device's web page at once.</li>
        <li><b>Network tools</b>: ping, TCP port check (multiple ports and ranges), DNS lookup, subnet calculator (network, usable range, host count and wildcard mask from 10.0.0.5/24 or a netmask). With <b>Keep sending</b> on, Ping sends every second until stopped and shows whether it answers and for how long, the loss, a chart of the last two minutes of round trips and a record of each drop and recovery, with a sound and a notification on each change (three echoes in a row unanswered count as down). Use it to watch a device come back after a restart. IP scan pings every address of a subnet (up to a /22, 1022 hosts) and lists the devices that answer with their round trip; "Copy addresses with no answer" gathers the IPs likely free (devices whose firewall blocks ping also show as not answering). Click an address in the results to ping it, check its ports, start a new session or copy it; the Name column shows the device name from DNS or the hosts file. Coming back to IP scan from another tool shows the last results again. Devices on this PC's own network segment (not behind a router) also show their MAC address, which can be copied in Linux, Windows, Cisco or Huawei notation. A device on that segment that blocks ping but answered ARP is listed as "No answer (seen by ARP)" and left out of the addresses with no answer. An address with no name that a saved session connects to shows that session's name, dimmed, and "Connect" in its menu opens the session at once (the same in the Syslog window's sender menu). Scanning the same range again compares it with the last scan: devices answering for the first time are marked "new", and the addresses that did not answer this time are listed (kept for the last 20 ranges, also after a restart; a scan from another day shows its date). As you type in the host box, the saved sessions' addresses are suggested with their names (serial ports left out). Among the addresses not answering this time, a saved session's device is listed first, by its name. When a device watched with "Keep sending" stops answering, the tabs connected to it are tinted red too until you bring them to the front. The "Check ports" results show the IANA service name of well-known ports in a "Service" column, and clicking the number of an open SSH, Telnet, FTP, FTPS, RDP or VNC port offers "New session to this port…", which opens a new session with that protocol and port filled in. "Watch with continuous ping" in the menu of an IP address in the terminal output or in the IP scan results starts it at once with "Keep sending" on (to see a device come back after a restart). The host box of the session editor suggests the addresses that sent Syslog messages or answered an IP scan and have no session yet, with where each was seen, so a newly found device is set up without typing its address again. Clicking a column heading of the IP scan or port check results (address, name, MAC, round trip; port, state, round trip) sorts by it, and clicking again sorts the other way (addresses in numeric order, empty values always last).</li>
        <li><b>Traceroute</b>: "Traceroute" in the network tools checks each router on the way to a destination three times, as tracert does, and lists the address, name (DNS) and round trips of every hop as it answers. A hop that does not answer shows as * (often a firewall), and several addresses at one hop are a load-shared path. The box next to it is the maximum number of hops (30 by default); it ends when the destination answers or a router says it is unreachable. Click a hop's address for Ping, the port check or a new session. It needs no administrator rights and is IPv4 only. "Traceroute" in the menu of an IPv4 address in the terminal output, or of an address in the IP scan results, starts it at once. A hop with no DNS name shows the name of a saved session to that address instead, dimmed (routers and switches on the way are easier to recognise).</li>
        <li><b>File servers</b>: The file server button at the top temporarily shares a folder on this PC over FTP, TFTP or HTTP (e.g. for uploading device OS images).</li>
        <li><b>Syslog receiver</b>: start it from the file server button at the top → "Syslog receiver", and messages from devices set to send their logs to this PC (Cisco's <code>logging host this-PC-address</code>, for example) show as they arrive (UDP, port 514 by default). Each comes with the sender's address and its severity (emerg to debug); filter them, keep only "warning and above" and the like, copy the visible lines or save them to a file. Receiving goes on when the window is closed; while it runs the status bar shows it, and clicking there opens it again. The latest 20,000 messages are kept. Click a sender's address to show only that device's messages (that exact address), open the network tools, or start a new session to it. If a tab connected to that address is open, "Go to this device's tab" brings it to the front. With "Alerts" on, an err or worse message (err, crit, alert, emerg) beeps and flashes the taskbar, with a Windows notification when the app is not in front. It works with the window closed too; a flapping link is told at most every 30 seconds, the messages that came meanwhile counted together. With "Save to a file as they come" on, every message, also those the window cannot show, is added to the end of the chosen file as it arrives, one line each (time, sender, severity, message, tab-separated). If the file cannot be written, saving stops and you are told. The "From" button in the toolbar lists the devices that sent messages, busiest first, with how many of theirs are err or worse; pick one to see only its messages ("Show messages from every device" goes back). Words typed in the filter are highlighted in the messages. With the button next to "Alerts" you can set alert words, comma-separated (UPDOWN, BGP): a message with one of them alerts whatever its severity and is marked with a yellow bar in the list (case ignored, up to 20). "Show" in an alert opens the messages of that device alone when every alerted message came from it. A tab connected to a device that sent a message of err or worse, or one with an alert word, is tinted red until you bring it to the front, even with the alert off. "This device's Syslog messages" in the right-click menu of a tab connected to a sender shows that device's messages at once. For a device with no tab open, its session in the session list gets a red warning icon (likewise for a device whose continuous ping went unanswered); it goes once you connect that session or bring one of its tabs to the front. The home screen, shown when no tab is open, gathers such devices at the top under "Devices needing attention", and a warning you already know about can be put away without connecting with "Clear warning mark" in the session's right-click menu. While some device is marked, "Needs attention: N" shows in the status bar; its list goes to the device's tab, connects its saved session or opens its Syslog messages, and "Clear all warning marks" puts them all away. A mark shows when it first happened, and a closed folder gets the icon on its row when a marked session is inside. The command palette lists marked sessions first, and the "Next marked tab" command (give it a key yourself) goes through the marked tabs in turn. While saving to a file, the window shows the file's current size, read again every few seconds (the file is never split or deleted by the app, so tidy it up yourself when it grows). Past 1 GB the size turns to the warning colour.</li>
      </ul>`,
  },
  {
    id: "security",
    title: "Credentials · Security",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>Credential vault</b> (key button at the top): Stores passwords and SSH keys in Windows Credential Manager for use in the session editor. Saved passwords are never sent to the screen. Keys can be in OpenSSH or PuTTY (.ppk) format. The vault and the session editor warn about key files that cannot be used (missing, another format, readable by other users); <b>Fix permissions</b> makes a key readable by this user only. When OpenSSH ignores such a key in the terminal, <b>Fix key file permissions</b> in the notice fixes it and reconnects. Selecting an item in the vault shows the sessions that use it, so you can see which sessions a new password or key affects.</li>
        <li><b>Master password</b> (Settings → Security): Locks the app on startup and after you've been away.</li>
        <li>SSH/SFTP host keys are checked against <code>~/.ssh/known_hosts</code>; unknown keys show a fingerprint for confirmation. Changed keys block the connection. If you are sure the server was reinstalled, <b>Remove saved key</b> in that dialog deletes the old key, and the next connection shows the new fingerprint for you to check and trust (terminal, files and SSH gateway).</li>
      </ul>`,
  },
  {
    id: "update",
    title: "Updates",
    icon: "RefreshCw",
    body: `
      <p>At startup and <b>every 30 minutes</b> while running (and when you come back to the window after a while), the app checks <b>GitHub</b> (github.com/NijG/bananaconn) for a new version. On a PC whose security policy blocks GitHub, set a <b>NAS update folder</b> (a shared folder new versions are published to) in Settings → Update; it is checked when GitHub cannot be reached. When a new version is found, a <b>window asks whether to update now</b>. "Update now" closes the app, installs and reopens it (open connections are closed). With "Later", the <b>Update</b> button on the right of the status bar installs it at any time. The window starts with "Later" selected, so an Enter typed for a terminal never starts an update.</p>
      <p><b>When it fails with "the password is incorrect"</b>: Windows connects to a shared folder with the Windows account you are signed in with, and does not fall back to guest access even when the share allows anonymous (guest) reading. Open the update folder in Explorer, enter the NAS account and tick "Remember my credentials", or choose an account from the credential vault under <b>NAS account</b> in Settings → Update. The app then logs in with it. If the chosen NAS account is refused, automatic checks stop logging in with it (so wrong passwords do not pile up and lock the account) and Settings says so; after fixing its password, "Check now" uses it again.</p>
      <p>Only files signed by the build PC are installed, so files placed in the shared folder by others are not installed. You can also check right away with "Check now".</p>`,
  },
  {
    id: "keys",
    title: "Keyboard shortcuts",
    icon: "Keyboard",
    body: `
      <p>All shortcuts can be viewed and changed in <b>Settings → Keyboard shortcuts</b> (or "Keyboard shortcut settings" on the home screen). Actions without a shortcut (layouts, n-th tab, logging …) and snippets or macros can get one too, and "Default" per action or "Reset all to defaults" undoes the changes. The table below shows the defaults.</p>
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>This help (inside a terminal it goes to the remote program)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>New session</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>Go to Quick connect</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>Next / previous tab</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>Close tab</td></tr>
        <tr><td>${kbd("Ctrl+Shift+T")}</td><td>Reopen closed tab</td></tr>
        <tr><td>Double-click tab</td><td>Open the same session again</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>Find in terminal</td></tr>
        <tr><td>${kbd("Ctrl")}+wheel</td><td>Terminal font size</td></tr>
        <tr><td>${kbd("Ctrl+0")}</td><td>Reset terminal font size</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>Collapse sidebar</td></tr>
        <tr><td colspan="2"><b>In the session list</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>Connect / Edit / Delete (applies to all when several are selected)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+C")}</td><td>Copy address (one per line when several are selected)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>Copy / paste sessions</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+click, ${kbd("Ctrl+A")}</td><td>Multi-select</td></tr>
      </table>`,
  },
];
