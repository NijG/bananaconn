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
      <p>Save connection details with the ${icon("Plus", 13)} button in the session list (${kbd("Ctrl+Shift+N")}), then connect by double-clicking or pressing ${kbd("Enter")}. Connections saved in other programs can be moved over in one go with <a data-goto="import">Import</a>.</p>
      <h4>Screen language</h4>
      <p><b>Language</b> at the top of Settings switches the screen to 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français or Deutsch (at once, without disconnecting; the guide and update notes follow it too). Until you choose, the app follows the Windows display language; once you choose, your choice always wins.</p>`,
  },
  {
    id: "sessions",
    title: "Session list",
    icon: "Server",
    body: `
      <ul>
        <li><b>Folders</b>: In the session editor, write the folder with slashes, like <code>Prod/Web servers</code>, to create subfolders. You can also drag a session onto a folder to move it.</li>
        <li><b>Sorting and order</b>: The sort button above the session list chooses by name (AP2 before AP10), by address (IPs compared as numbers), recently connected, or custom. Drag a session above or below another to put it there; folders are reordered, or moved into another folder, the same way. Reordering switches to the custom order, which is kept. ${kbd("Alt+Up")} / ${kbd("Alt+Down")} move the selected session one place, and "Sort this folder by name/address" in a folder's menu tidies it in one go.</li>
        <li><b>Search</b>: Type part of a name, host, user or note into the search box at the top.</li>
        <li><b>Multi-select</b>: ${kbd("Ctrl")}+click to pick one at a time, ${kbd("Shift")}+click to pick a range. ${kbd("Shift+↑/↓")} and ${kbd("Ctrl+A")} also work. ${kbd("Esc")} clears the selection.</li>
        <li><b>Bulk actions</b>: With several selected, right-click → Bulk edit (${kbd("F2")}: user, port, credential, folder, key mode), Move to folder, Delete (${kbd("Del")}), Connect all (${kbd("Enter")}).</li>
        <li><b>Copy &amp; paste</b>: Select a session and press ${kbd("Ctrl+C")}, select a session in the target folder and press ${kbd("Ctrl+V")}. Each paste creates a new session named "Name (2)", "Name (3)". Right-click → Duplicate does the same.</li>
        <li><b>Edit</b>: ${kbd("F2")} or right-click → Edit.</li>
      </ul>`,
  },
  {
    id: "import",
    title: "Import from other programs",
    icon: "Download",
    body: `
      <p>Choose from the ${icon("Download", 13)} button above the session list. A preview list is shown before importing, and existing sessions are skipped. <b>Passwords are not imported</b> (each program encrypts them with its own key). Enter them on first connect or assign one from the credential vault.</p>
      <table class="help-table">
        <tr><th>Program</th><th>What to choose</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (portable: next to the executable)</td></tr>
        <tr><td>SecureCRT</td><td>Session folder <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (including folder structure, log file names and auto-logging settings), or an XML made with File → Export Settings</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (if full-file encryption is on, turn it off and save first)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>Reads this PC's settings directly</td></tr>
        <tr><td>WinSCP</td><td>This PC's settings, or <code>WinSCP.ini</code> if none</td></tr>
        <tr><td>Xshell</td><td>The <code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code> folder</td></tr>
        <tr><td>RDCMan</td><td><code>.rdg</code> file</td></tr>
        <tr><td>Remote Desktop</td><td>A folder containing <code>.rdp</code> files (subfolders included)</td></tr>
        <tr><td>CSV</td><td>Column names on the first line: Name, Protocol, Host, Port, Username, Folder (comma, semicolon or tab separated)</td></tr>
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
        <li><b>Switch tabs</b>: ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. With many tabs, scroll the mouse wheel over the tab bar to move left and right. Drag tabs to reorder them.</li>
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
        <li><b>Copy &amp; paste</b>: Selecting by dragging copies immediately, and right-click pastes (configurable in Settings). ${kbd("Ctrl+C")} copies only when there is a selection; otherwise it is sent to the device.</li>
        <li><b>Font size</b>: ${kbd("Ctrl")}+mouse wheel, or ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)} in the toolbar.</li>
        <li><b>Find</b>: ${kbd("Ctrl+Shift+F")}.</li>
        <li><b>Key mode</b>: If Delete, Home or End print <code>~</code> on devices such as Cisco IOS, switch the toolbar to "Keys: device" (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). You can set the default in the session editor.</li>
        <li><b>Serial</b>: In the session editor, set the COM port ("Find ports"), speed, parity and flow control. Break in the toolbar sends a Break signal. A multi-line paste, or a configuration sent with Send a text file in the toolbar, goes one line at a time: each line is sent as soon as the device has taken the previous one and shown its prompt again, so fast devices get it quickly and slow ones drop no characters. Progress is shown while sending; ${kbd("Ctrl+C")}, Break or Stop in the progress box drops the remaining lines. For devices that do not echo input, choose fixed delays in Settings → Terminal. Telnet sessions through a console server work the same way when "Console-server connection" is on in the session editor. When a USB serial adapter is unplugged, the tab waits for the port and reconnects as soon as it is plugged back in. Port I/O uses a fast mode in which keystrokes never wait for a pending read; should a driver misbehave, switch to compatibility mode in Settings → Terminal.</li>
        <li><b>Output keyword highlighting</b>: ERROR·FAIL in red, WARN in yellow, OK·SUCCESS in green.</li>
        <li><b>Rendering</b> (Settings → Terminal): "Auto" draws with the GPU (WebGL) on PCs with a graphics card, speeding up heavy output, and uses the standard renderer on servers and remote sessions without one. Only terminals visible on screen use the GPU.</li>
        <li><b>Snippets &amp; macros</b>: Save frequently used commands under Snippets in the toolbar, and use "Record" to capture input and play it back.</li>
        <li><b>Files</b> (SSH): The Files button in the toolbar opens an SFTP pane for the same server alongside.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "Broadcast input",
    icon: "Radio",
    body: `
      <p>Turn on <b>Broadcast input</b> at the top and keys typed in the current terminal go to <b>every connected terminal tab</b> (including tabs not on screen). Receiving tabs have a blinking dot. Use it to send the same command to several devices, and be sure to turn it off when done. Each tab sends Delete, Home and End according to its own key mode (standard/device).</p>`,
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
      <p><b>Built-in snippets per OS</b>: common read-only checks (commands that change nothing) for Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS · NX-OS · ASA, FortiGate, Aruba, Juniper and Huawei. The snippet list shows your own snippets and those for the OS recognised in that tab first; other systems are one click away under "… snippets". Edit or delete them, or change their OS group, in Manage snippets.</p>
      <p><b>Risky commands</b>: every line a snippet or macro sends is checked against the rules in Settings → Risky commands. Commands that change the time or NTP (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) are <b>blocked</b> and never sent; commands such as reboots, deletions, formatting or device configuration changes need confirmation in a <b>warning</b> first. When sent, the tab's log is turned on, and every attempt, cancellation and block is recorded in <code>risky-commands.log</code> in the logs folder. Commands chained with <code>;</code> or <code>&amp;&amp;</code>, commands inside <code>sudo</code>, <code>su -c</code>, <code>bash -c</code> or <code>eval</code>, and lines continued with a trailing <code>\\</code> are checked too. Macros containing Tab completion or cursor keys (←→, Home, history ↑↓) get a warning, because the command actually sent cannot be known. Commands you type yourself are checked too: when you press Enter, the command line shown on the screen is matched against the same rules (including history ↑↓ and Tab completion). Full-screen programs such as vi or less are not checked, and the check can be turned off in Settings → Risky commands.</p>
      <p><b>Colours and suggestions while typing</b>: the command typed after the prompt is coloured by commands, options, strings, paths and operators, and turns red before Enter when a risky-command rule matches. The rest of a command is suggested in grey from the commands run before (kept on this PC only) and from snippets: <kbd>→</kbd> or <kbd>End</kbd> types all of it, <kbd>Ctrl</kbd>+<kbd>→</kbd> one word at a time. <kbd>Tab</kbd> stays the server's own completion. <kbd>Ctrl</kbd>+<kbd>Space</kbd> opens a list of candidates (↑↓ to pick, Enter or Tab to type it, Esc to close). Candidates come from your history, snippets, a command dictionary for the recognised device (Linux, AIX, HP-UX, Solaris, Windows, Cisco, FortiGate, Aruba, Juniper, Huawei) and, on Unix servers with the resource monitor on, the program names on the server's PATH. Those names are read once over the monitor's connection; nothing is typed into the terminal. The command line is read from the screen, so passwords, which are not shown, are never recorded, and risky commands and commands holding a password or token (<code>mysql -p…</code>, <code>--password=…</code>, <code>TOKEN=…</code>) are neither recorded nor suggested; <kbd>Shift</kbd>+<kbd>Delete</kbd> in the candidates list removes a mistyped entry. Both can be turned off in Settings → Terminal, where the command history can also be cleared.</p>
      <p><b>ls colours</b>: on servers whose ls has no colours, such as AIX, HP-UX and Solaris, folders (blue), programs (green), links (cyan) and archives (red) are coloured as on Linux. ls -l and ls -F are read from their output; for a plain ls the folder is read separately over the resource monitor's connection (when the prompt shows the path). Nothing is sent to the terminal, and a listing the server coloured itself is left alone. Turn it off in Settings → Terminal.</p>
      <h4>Create and send snippets</h4>
      <ol>
        <li>In the terminal toolbar: <b>Snippets</b> → <b>Manage snippets…</b> → <b>New snippet</b>.</li>
        <li>Enter a name and the content to send. Multiple lines are sent one at a time with Enter (e.g. <code>terminal length 0</code> followed by <code>show running-config</code> on the next line).</li>
        <li>With <b>Press Enter after sending</b> on, the last line runs right away; with it off, the command is only typed and waits.</li>
        <li>To send one, click <b>Snippets</b> in the toolbar and pick it from the list.</li>
      </ol>
      <h4>Record and play macros</h4>
      <ol>
        <li>Click <b>Record</b> in the terminal toolbar; the button changes to <b>Stop recording</b> and every key you type from then on is saved as-is (including Enter, Tab, Ctrl keys, arrow keys and IME input).</li>
        <li>Type commands on the device as usual. Snippets you send are recorded into the macro too.</li>
        <li>Click <b>Stop recording</b> and give it a name to save.</li>
        <li>To replay, pick the item marked <b>Macro</b> from the <b>Snippets</b> list in the toolbar. The recorded keys are sent in order, exactly as typed.</li>
      </ol>
      <ul>
        <li><b>Many devices at once</b>: Send a snippet or macro while <b>Broadcast input</b> is on at the top and it goes to every connected terminal tab.</li>
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
        <li>Double-click a text file on the server to open it in the built-in editor; saving writes it straight back to the server.</li>
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
        <li><b>SSH tunnels</b>: Tools at the top → SSH tunnels. Save forwardings of local port → SSH server → target address and turn them on and off.</li>
        <li><b>Network tools</b>: ping, TCP port check (multiple ports and ranges), DNS lookup.</li>
        <li><b>File servers</b>: The file server button at the top temporarily shares a folder on this PC over FTP, TFTP or HTTP (e.g. for uploading device OS images).</li>
      </ul>`,
  },
  {
    id: "security",
    title: "Credentials · Security",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>Credential vault</b> (key button at the top): Stores passwords and SSH keys in Windows Credential Manager for use in the session editor. Saved passwords are never sent to the screen.</li>
        <li><b>Master password</b> (Settings → Security): Locks the app on startup and after you've been away.</li>
        <li>SSH/SFTP host keys are checked against <code>~/.ssh/known_hosts</code>; unknown keys show a fingerprint for confirmation. Changed keys block the connection.</li>
      </ul>`,
  },
  {
    id: "update",
    title: "Updates",
    icon: "RefreshCw",
    body: `
      <p>At startup and <b>every 30 minutes</b> while running (and when you come back to the window after a while), the app checks <b>GitHub</b> (github.com/NijG/bananaconn) for a new version. On a PC whose security policy blocks GitHub, set a <b>NAS update folder</b> (a shared folder new versions are published to) in Settings → Update; it is checked when GitHub cannot be reached. When a new version is found, a <b>window asks whether to update now</b>. "Update now" closes the app, installs and reopens it (open connections are closed). With "Later", the <b>Update</b> button on the right of the status bar installs it at any time. The window starts with "Later" selected, so an Enter typed for a terminal never starts an update.</p>
      <p><b>When it fails with "the password is incorrect"</b>: Windows connects to a shared folder with the Windows account you are signed in with, and does not fall back to guest access even when the share allows anonymous (guest) reading. Open the update folder in Explorer, enter the NAS account and tick "Remember my credentials", or choose an account from the credential vault under <b>NAS account</b> in Settings → Update. The app then logs in with it.</p>
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
        <tr><td>Double-click tab</td><td>Open the same session again</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>Find in terminal</td></tr>
        <tr><td>${kbd("Ctrl")}+wheel</td><td>Terminal font size</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>Collapse sidebar</td></tr>
        <tr><td colspan="2"><b>In the session list</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>Connect / Edit / Delete (applies to all when several are selected)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>Copy / paste sessions</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+click, ${kbd("Ctrl+A")}</td><td>Multi-select</td></tr>
      </table>`,
  },
];
