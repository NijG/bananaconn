// Simplified Chinese version of the in-app usage guide (same sections, ids and icons as help.ts).

import type { HelpSection } from "../help";
import { icon } from "../icons";
import { esc } from "../ui";

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

export const SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "快速入门",
    icon: "Sparkles",
    body: `
      <p>BananaConn 是一款远程访问工具，将 SSH、Telnet、串口 (COM)、SFTP、FTP/FTPS、RDP 和 VNC 连接集中在标签页中。</p>
      <h4>立即连接 (快速连接)</h4>
      <ol>
        <li>在左上角选择协议 (SSH、Telnet …)。</li>
        <li>在旁边的输入框中输入 <code>user@host:port</code> 并按 ${kbd("Enter")}。示例：<code>root@10.0.0.5</code>、<code>admin@192.168.0.1:2222</code></li>
        <li>串口请输入 <code>COM3</code> 或 <code>COM3:115200</code>。</li>
      </ol>
      <h4>保存为会话</h4>
      <p>使用会话列表中的 ${icon("Plus", 13)} 按钮 (${kbd("Ctrl+Shift+N")}) 保存连接信息，之后双击或按 ${kbd("Enter")} 即可连接。在其他程序中保存的连接可以通过<a data-goto="import">导入</a>一次性迁移过来。</p>
      <h4>界面语言</h4>
      <p>设置顶部的<b>语言</b>可将界面切换为 한국어、English、日本語、简体中文、繁體中文、Tiếng Việt、Español、Français 或 Deutsch (立即生效，不会断开连接；指南和更新说明也会随之切换)。在您选择之前，应用跟随 Windows 显示语言；一旦选择，始终以您的选择为准。</p>`,
  },
  {
    id: "sessions",
    title: "会话列表",
    icon: "Server",
    body: `
      <ul>
        <li><b>文件夹</b>：在会话编辑器中用斜杠书写文件夹，如 <code>Prod/Web servers</code>，即可创建子文件夹。也可以将会话拖到文件夹上进行移动。</li>
        <li><b>排序与顺序</b>：会话列表上方的排序按钮可选择按名称（AP2 在 AP10 之前）、按地址（IP 按数字比较）、按最近连接或自定义。将会话拖到另一个会话的上方或下方即可放到那里；文件夹也可用同样方式调整顺序或移入其他文件夹。调整顺序后会切换为自定义排序并保留该顺序。${kbd("Alt+Up")} / ${kbd("Alt+Down")} 可将所选会话上下移动一格，文件夹菜单中的“将此文件夹内容按名称/地址排序”可一次整理。</li>
        <li><b>搜索</b>：在顶部搜索框中输入名称、主机、用户或备注的一部分。</li>
        <li><b>多选</b>：${kbd("Ctrl")}+单击逐个选择，${kbd("Shift")}+单击选择范围。${kbd("Shift+↑/↓")} 和 ${kbd("Ctrl+A")} 同样可用。${kbd("Esc")} 清除选择。</li>
        <li><b>批量操作</b>：选中多个后，右键 → 批量编辑 (${kbd("F2")}：用户、端口、凭据、文件夹、按键模式)、移动到文件夹、删除 (${kbd("Del")})、全部连接 (${kbd("Enter")})。</li>
        <li><b>复制 &amp; 粘贴</b>：选中会话后按 ${kbd("Ctrl+C")}，在目标文件夹中选中一个会话后按 ${kbd("Ctrl+V")}。每次粘贴都会创建一个名为“名称 (2)”、“名称 (3)”的新会话。右键 → 复制副本效果相同。</li>
        <li><b>编辑</b>：${kbd("F2")} 或右键 → 编辑。</li>
      </ul>`,
  },
  {
    id: "import",
    title: "从其他程序导入",
    icon: "Download",
    body: `
      <p>通过会话列表上方的 ${icon("Download", 13)} 按钮选择。导入前会显示预览列表，已存在的会话会被跳过。<b>不会导入密码</b> (各程序使用自己的密钥加密)。请在首次连接时输入，或从凭据库中分配。</p>
      <table class="help-table">
        <tr><th>程序</th><th>选择内容</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (便携版：位于可执行文件旁)</td></tr>
        <tr><td>SecureCRT</td><td>会话文件夹 <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (包括文件夹结构、日志文件名和自动日志设置)，或通过 文件 → 导出设置 生成的 XML</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (如果开启了整个文件加密，请先关闭并保存)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>直接读取本机设置</td></tr>
        <tr><td>WinSCP</td><td>本机设置，没有时选择 <code>WinSCP.ini</code></td></tr>
        <tr><td>Xshell</td><td><code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code> 文件夹</td></tr>
        <tr><td>RDCMan</td><td><code>.rdg</code> 文件</td></tr>
        <tr><td>远程桌面</td><td>包含 <code>.rdp</code> 文件的文件夹 (包括子文件夹)</td></tr>
        <tr><td>CSV</td><td>第一行为列名：Name, Protocol, Host, Port, Username, Folder (以逗号、分号或制表符分隔)</td></tr>
      </table>
      <p>在不同的 BananaConn 安装之间，请使用同一菜单中的<b>导出/导入会话备份 (JSON)</b>。备份中除会话外，还包含空文件夹、片段/宏和 SSH 隧道。在同一台电脑上恢复时，凭据关联也会保留；即使所有会话都已存在，也可以只恢复缺少的文件夹、片段和隧道。SSH 隧道和安全相关选项 (忽略证书错误、端口转发、日志文件位置等) 仅在开启“同时导入安全相关选项”时才会导入。</p>`,
  },
  {
    id: "tabs",
    title: "标签页和分屏",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>关闭标签页</b>：${kbd("Ctrl+F4")} 或 ${kbd("Ctrl+Shift+W")}，或用鼠标中键单击标签页。在确认框中按 ${kbd("Enter")} 关闭；勾选“不再询问”下次将跳过确认 (可在设置中重新开启)。</li>
        <li><b>再次打开同一会话</b>：<b>双击</b>标签页。便于为监控而再建立一个到同一设备的连接。</li>
        <li><b>切换标签页</b>：${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}。标签页较多时，在标签栏上滚动鼠标滚轮可左右移动。拖动标签页可调整顺序。</li>
        <li><b>分屏</b>：顶部的 单屏 / 左右 / 上下 / 四分屏 按钮。将标签页拖到想要的窗格中。</li>
        <li>标签页圆点的颜色表示协议，闪烁表示正在连接，红色表示出错。</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "终端 (SSH · Telnet · 串口)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>复制 &amp; 粘贴</b>：拖动选中即立即复制，右键粘贴 (可在设置中更改)。${kbd("Ctrl+C")} 仅在有选中内容时复制，否则会发送到设备。</li>
        <li><b>字号</b>：${kbd("Ctrl")}+鼠标滚轮，或工具栏中的 ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)}。</li>
        <li><b>查找</b>：${kbd("Ctrl+Shift+F")}。</li>
        <li><b>按键模式</b>：如果在 Cisco IOS 等设备上按 Delete、Home 或 End 会输出 <code>~</code>，请将工具栏切换为“按键：设备”(Delete=Ctrl-D、Home=Ctrl-A、End=Ctrl-E)。默认值可在会话编辑器中设置。</li>
        <li><b>串口</b>：在会话编辑器中设置 COM 端口 (“查找端口”)、速率、校验位和流控。工具栏中的 Break 发送 Break 信号。粘贴多行内容或用工具栏的“发送文本文件”发送配置时，会逐行发送：设备每接收一行并重新显示提示符，就立即发送下一行，因此快的设备很快收完，慢的设备也不会丢字符。发送时会显示进度；按 ${kbd("Ctrl+C")}、Break 或进度框中的“停止”可放弃剩余的行。对不回显输入的设备，可在 设置 → 终端 中改用固定延迟。经控制台服务器的 Telnet 会话在会话编辑中打开“控制台服务器连接”后，也按同样方式发送。USB 串口适配器被拔出时，标签页会等待该端口，重新插入后自动连接。端口输入输出使用快速方式，按键不会被等待读取阻塞；如驱动程序有问题，可在 设置 → 终端 中改为兼容模式。</li>
        <li><b>输出关键字高亮</b>：ERROR·FAIL 为红色，WARN 为黄色，OK·SUCCESS 为绿色。</li>
        <li><b>渲染</b> (设置 → 终端)：“自动”在有显卡的电脑上使用 GPU (WebGL) 绘制，加快大量输出；在没有显卡的服务器和远程会话中使用标准渲染器。只有屏幕上可见的终端才使用 GPU。</li>
        <li><b>片段 &amp; 宏</b>：将常用命令保存在工具栏的“片段”中，使用“录制”捕获输入并回放。</li>
        <li><b>文件</b> (SSH)：工具栏中的“文件”按钮会在旁边打开同一服务器的 SFTP 窗格。</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "同步输入",
    icon: "Radio",
    body: `
      <p>开启顶部的<b>同步输入</b>后，在当前终端中输入的按键会发送到<b>所有已连接的终端标签页</b> (包括不在屏幕上的标签页)。接收输入的标签页上会有闪烁的圆点。可用于向多台设备发送相同命令，用完后务必关闭。各标签页按各自的按键模式 (标准/设备) 发送 Delete、Home 和 End。</p>`,
  },
  {
    id: "log",
    title: "会话日志",
    icon: "ScrollText",
    body: `
      <p>使用工具栏中的<b>日志</b>按钮开始和停止。开始时可以检查和修改文件名 (可在设置中关闭)，点击状态栏中的“正在记录日志”会打开文件所在的文件夹。</p>
      <h4>文件名替换符 (与 SecureCRT 相同)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> 会话名</td><td><code>%H</code> 主机</td><td><code>%U</code> 用户</td><td><code>%P</code> 端口</td></tr>
        <tr><td><code>%Y</code> 年 (4 位)</td><td><code>%M</code> 月</td><td><code>%D</code> 日</td><td><code>%%</code> % 符号</td></tr>
        <tr><td><code>%h</code> 时</td><td><code>%m</code> 分</td><td><code>%s</code> 秒</td><td><code>%t</code> 毫秒</td></tr>
      </table>
      <p>示例：<code>D:\\Checks\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\Checks\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>。不存在的文件夹会自动创建。相对路径位于 文档\\BananaConn\\logs 下。</p>
      <ul>
        <li><b>如果文件已存在</b>：追加 / 覆盖 / 新文件 (-2、-3 …)。</li>
        <li><b>行前缀</b>：例如 <code>[%h:%m:%s] </code> 为每一行加上时间戳。</li>
        <li><b>开始时 / 停止时</b>：写入文件的文本 (可使用替换符)。</li>
        <li><b>过了午夜写入新文件</b>：如果文件名包含 <code>%D</code>，日期变化时将在新文件中继续记录。</li>
        <li><b>连接时自动记录日志</b>：对所有会话 (设置 → 日志) 或按会话设置 (会话编辑器 → 日志 → 仅此会话)。</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "片段 · 宏",
    icon: "Circle",
    body: `
      <p>保存常用命令 (片段)，或录制在终端中输入的按键并原样再次发送 (宏)。</p>
      <p><b>各操作系统的内置片段</b>：适用于 Linux、AIX、HP-UX、Solaris、Windows、Cisco IOS · NX-OS · ASA、FortiGate、Aruba、Juniper 和 Huawei 的常用只读检查 (不做任何更改的命令)。片段列表优先显示您自己的片段和该标签页中识别出的操作系统的片段；其他系统的片段在“… 片段”下，点击即可查看。可在“管理代码片段”中编辑、删除或更改其 OS 分组。</p>
      <p><b>危险命令</b>：片段或宏发送的每一行都会按 设置 → 危险命令 中的规则进行检查。更改时间或 NTP 的命令 (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) 会被<b>阻止</b>，不会发送；重启、删除、格式化或更改设备配置等命令需要先在<b>警告</b>中确认。发送时会开启该标签页的日志记录，每次尝试、取消和阻止都会记录到日志文件夹中的 <code>risky-commands.log</code>。用 <code>;</code>、<code>&amp;&amp;</code> 连接的命令，<code>sudo</code>、<code>su -c</code>、<code>bash -c</code>、<code>eval</code> 中的命令，以及用行尾 <code>\\</code> 续行的命令也会被检查。包含 Tab 补全或光标移动键 (←→、Home、命令历史 ↑↓) 的宏会发出警告，因为无法确定实际发送的命令。自己输入的命令也会检查：按 Enter 时，会用相同的规则检查屏幕上显示的命令行（包括命令历史 ↑↓ 和 Tab 补全的结果）。vi、less 等全屏程序中不检查，可在设置 → 危险命令中关闭此检查。</p>
      <p><b>输入命令时的着色与自动补全</b>：提示符后正在输入的命令会按命令、选项、字符串、路径和连接符号着色，符合危险命令规则时在按 Enter 之前变为红色。根据以前执行过的命令（仅保存在本机）和代码片段，以灰色建议命令的其余部分：<kbd>→</kbd> 或 <kbd>End</kbd> 输入全部，<kbd>Ctrl</kbd>+<kbd>→</kbd> 逐词输入。<kbd>Tab</kbd> 仍是服务器自己的补全。<kbd>Ctrl</kbd>+<kbd>Space</kbd> 打开候选列表（↑↓ 选择，Enter 或 Tab 输入，Esc 关闭）。候选项依次来自执行历史、代码片段、已识别设备的命令词典（Linux、AIX、HP-UX、Solaris、Windows、Cisco、FortiGate、Aruba、Juniper、Huawei），以及开启资源监视器的 Unix 服务器 PATH 中的程序名。这些程序名通过监视器连接只读取一次，不会在终端中输入任何内容。命令行从屏幕读取，因此不显示的密码不会被记录，危险命令以及含有密码或令牌的命令（<code>mysql -p…</code>、<code>--password=…</code>、<code>TOKEN=…</code>）既不记录也不建议。输错的历史记录可在候选列表中按 <kbd>Shift</kbd>+<kbd>Delete</kbd> 删除。可在设置 → 终端中分别关闭，并清除命令历史。</p>
      <p><b>ls 列表的颜色</b>：在 AIX、HP-UX、Solaris 等 ls 不着色的服务器上，也像 Linux 一样用颜色区分文件夹 (蓝)、可执行文件 (绿)、链接 (青) 和压缩文件 (红)。ls -l 和 ls -F 根据输出判断；普通 ls 会通过资源监视连接另行读取该文件夹 (提示符显示路径时)。不会向终端发送任何内容，服务器自己着色的列表保持原样。可在设置 → 终端中关闭。</p>
      <h4>创建和发送片段</h4>
      <ol>
        <li>在终端工具栏中：<b>片段</b> → <b>管理代码片段…</b> → <b>新建片段</b>。</li>
        <li>输入名称和要发送的内容。多行内容会逐行加 Enter 发送 (例如 <code>terminal length 0</code>，下一行为 <code>show running-config</code>)。</li>
        <li>开启<b>发送后按 Enter</b> 时，最后一行会立即执行；关闭时只输入命令并等待。</li>
        <li>发送时，点击工具栏中的<b>片段</b>并从列表中选择。</li>
      </ol>
      <h4>录制和回放宏</h4>
      <ol>
        <li>点击终端工具栏中的<b>录制</b>；按钮会变为<b>停止录制</b>，此后输入的每个按键都会原样保存 (包括 Enter、Tab、Ctrl 组合键、方向键和输入法输入)。</li>
        <li>像平常一样在设备上输入命令。发送的片段也会被录入宏中。</li>
        <li>点击<b>停止录制</b>并命名后保存。</li>
        <li>回放时，从工具栏的<b>片段</b>列表中选择标有<b>宏</b>的项目。录制的按键会按输入时的顺序原样发送。</li>
      </ol>
      <ul>
        <li><b>同时操作多台设备</b>：在顶部<b>同步输入</b>开启时发送片段或宏，会发送到所有已连接的终端标签页。</li>
        <li><b>不要录制密码</b>：宏会原样保存按键，因此录制期间输入的密码也会被保存。</li>
        <li>可以在<b>管理代码片段…</b>中查看宏内容 (⏎ = Enter、⇥ = Tab、^C = Ctrl+C)。可以重命名和删除，但无法编辑按键；如需更改请重新录制。</li>
        <li>片段和宏保存在本机，所有会话共享。</li>
      </ul>`,
  },
  {
    id: "ai",
    title: "AI（生成命令 · 解释 · 对话 · 分析）",
    icon: "Sparkles",
    body: `
      <p>连接云端 AI（API 密钥）、订阅 CLI 或本机的本地 LLM，协助终端工作。在设置 → AI 中添加服务并选择默认使用的 AI。</p>
      <ul>
        <li><b>连接方式</b>：API 密钥（Anthropic Claude、OpenAI、Google Gemini、OpenAI 兼容服务器）、订阅 CLI（Claude Code、Codex CLI、Gemini CLI：在本机安装并登录一次后，即可用您的订阅回答）、本地 LLM（Ollama，或 LM Studio、llama.cpp、vLLM 等 OpenAI 兼容服务器）。API 密钥保存在凭据保管库中；“加载列表”获取模型，“测试连接”试用服务。</li>
        <li><b>生成命令</b>（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>）：用文字描述要做的事，即可得到一条适合所识别设备或系统的命令。再按一次 Enter 将其放入输入行（不会执行），由您自己按 Enter 执行。危险命令规则同样适用：被阻止的命令（修改时间、NTP 等）甚至不会放入输入行。</li>
        <li><b>解释输出</b>（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>）：解释所选文本（若未选择则为屏幕上最近的输出）的含义、可能原因和后续步骤。</li>
        <li><b>AI 对话</b>（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>）：在终端右侧打开对话窗格。用“附加所选内容”一并发送输出；回答中每行命令旁的按钮可将其放入输入行。 拖动对话窗格的左边缘可调整宽度 (所有标签页记住同一宽度)，双击恢复默认宽度。</li>
        <li><b>AI 执行命令</b>：在 AI 对话中写下要做的事，AI 会在此终端中逐条执行命令，读取结果并分析。每次执行都显示在屏幕上，并全部记录在 <code>risky-commands.log</code> 中。只读命令（<code>df</code>、<code>free</code>、<code>systemctl status</code>、<code>show …</code>、<code>display …</code> 等）直接执行；可能更改系统的命令会等待您选择“执行”或“跳过”。符合阻止规则的命令（修改时间、NTP 等）绝不执行。每个问题最多 8 条命令，每条命令 30 秒后用 Ctrl+C 停止。可用对话窗格下方的按钮切换为“每条都确认”或“不执行”。</li>
        <li><b>配置与日志分析</b>：对话窗格中的文件按钮可选择配置或日志文件进行检查（安全问题、危险设置）或分析（错误、异常迹象）。网络设备可通过设备按钮 → “用 AI 检查配置”直接检查 running-config。</li>
        <li><b>发送的内容</b>：发送到云端 AI 之前，会显示将要发送的内容并请您确认（每个对话可选择“不再询问”）。密码、密钥和令牌（<code>password=…</code>、<code>-p…</code>、<code>enable secret</code>、<code>snmp-server community</code>、私钥等）始终会被隐藏；开启设置后，IP 地址和主机名也会替换为 IP_1、HOST_1 等再发送，回答中会还原为真实值。本地 LLM 不会离开本机，因此不会询问或隐藏。向外部 AI 发送公司设备信息前，请确认公司的安全策略。</li>
        <li>订阅 CLI：Claude Code 在关闭所有工具（不执行命令、不读取文件）的状态下于空文件夹中运行，Codex 在只读沙箱中运行。应用不会处理您的登录信息。</li>
        <li><b>附件与远程桌面</b>：用对话窗格的 📎 按钮、拖放或 <kbd>Ctrl</kbd>+<kbd>V</kbd>（截图）附加图片、PDF 和文本文件。文本文件会并入消息并应用隐藏；图片和 PDF 无法隐藏，会在预览中按原样显示。大图片会自动缩小。大多数服务接受图片；PDF 由 Claude、Gemini、OpenAI API 和 Claude Code 接受。在 RDP 和 VNC 中，工具栏的“AI”可截取远程屏幕来获得解释或附加到对话。远程桌面中 AI 不执行命令，回答中的命令可用复制按钮复制后粘贴到远程屏幕。</li>
        <li><b>在 RDP 电脑上由 AI 直接执行</b>：在 RDP 工具栏的“AI”→“通过 SSH 连接以便 AI 执行命令…”中会显示启用 OpenSSH 服务器的脚本。复制后在远程画面的管理员 PowerShell 中运行，再点击“检查连接并打开 SSH 会话”，即会检查 22 端口，并以相同的主机、账户和文件夹添加并打开 SSH 会话 (已有则直接打开)。在该会话中，AI 会立即执行 Get-*、ipconfig、systeminfo 等只读 PowerShell 命令，可能更改系统的命令则先请求确认。 VNC 的“AI”菜单中也有相同的项目，并会显示在 Linux/Unix 电脑上启用 SSH 服务器的命令 (VNC 密码不会用于 SSH 登录)。</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "设备识别 · CPU · 内存",
    icon: "Activity",
    body: `
      <p>通过 SSH 或 Telnet 连接时，单独的监控连接会自动识别设备类型，并在状态栏中显示设备名称和 CPU/内存 (服务器还会显示磁盘)。不会向终端输入任何内容。</p>
      <p>支持的设备：<b>Cisco</b> IOS · IOS-XE · NX-OS · ASA、<b>Fortinet</b> FortiGate、<b>Aruba</b> AOS-CX · AOS-Switch (ProCurve) · 无线控制器、<b>Juniper</b> Junos、<b>Huawei</b> VRP，以及运行 <b>Linux (Red Hat 等)</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b> 的服务器。</p>
      <ul>
        <li><b>设备按钮</b>：识别后，终端工具栏中会出现带有设备名称的按钮。点击即可一次性输入该设备的常用 show 命令 (接口、路由、VLAN、HA、错误日志等)。不包含任何更改配置的命令。</li>
        <li><b>备份配置</b>：对于网络设备，设备按钮 → “备份配置”会将 running-config (FortiGate 上为 <code>show</code>) 保存到 <code>devicename_datetime.cfg</code> 文件。它通过监控连接读取，因此不会干扰您正在操作的终端。如果设备因权限不足而拒绝，或未收到配置的结尾 (IOS 的 <code>end</code>、Huawei 的 <code>return</code> 等)，则不会保存。</li>
        <li><b>自动按键模式</b>：识别到网络设备时，尚未选择按键模式的会话会切换为设备模式 (Delete=Ctrl-D、Home=Ctrl-A、End=Ctrl-E)。</li>
        <li><b>占用最高的进程</b>：点击状态栏中的 CPU/内存，可查看 CPU 和内存占用前 10 的进程以及磁盘列表 (Linux)。</li>
        <li>监控会额外使用一次登录。<b>即使对同一设备打开了多个标签页，也只使用一个监控连接</b> (以节省设备的 VTY 线路)。</li>
        <li>轮询间隔：Linux 每 2 秒 (通过 Telnet 连接时每 10 秒)，网络设备每 15 秒，AIX/HP-UX/Solaris 每 10 秒。监控命令不会留在服务器的 shell 历史 (<code>~/.sh_history</code> 等) 中。当屏幕上没有该设备的标签页或窗口最小化时暂停 (设备每 5 分钟检查一次，以免登录断开)，再次显示时立即读取。</li>
        <li>如果出现“点击登录”，请点击并输入用于监控的密码 (不保存)。如果不知道密码，监控连接会在发送用户名之前断开，因此设备上不会留下登录失败记录。对于无需密码即可登录的 Telnet 设备，请将密码留空并开始。如果登录后设备还要求输入一次性验证码之类的内容，则不进行监控。要关闭此功能：设置 → 会话。</li>
      </ul>`,
  },
  {
    id: "files",
    title: "文件传输 (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>左侧是本机，右侧是服务器。将项目拖到另一侧或点击传输按钮。文件夹会连同其内容一起发送。</li>
        <li>如果存在同名文件，会询问是否覆盖。传输时显示进度，并可取消。</li>
        <li><b>TFTP</b>：将会话类型 (或快速连接) 选为 TFTP 即可打开 TFTP 标签页。TFTP 没有登录和文件夹列表，因此请输入<b>服务器上的文件名</b>并点击“获取”，或选择本机上的文件并点击“发送”。块大小“自动”适合大多数设备，不支持选项的旧服务器会自动回退到 512。要让设备向本机发送文件 (例如 <code>copy running-config tftp:</code>)，请在顶部“服务器”按钮下开启 <b>TFTP 服务器</b>。</li>
        <li>通过 SFTP 发送文件夹时一次传输 4 个文件，对于包含大量小文件的文件夹要快得多，在远距离传输时尤其明显。FTP 由于服务器连接数限制一次只发送一个，但在传输期间可以继续浏览文件夹。</li>
        <li>双击服务器上的文本文件即可在内置编辑器中打开；保存时直接写回服务器。</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "远程桌面 (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>屏幕大小</b>：如果会话分辨率为“自动”，则与标签页大小一致。调整窗口大小时远程分辨率也会随之调整；如果服务器不支持实时调整，会自动以新尺寸重新连接。</li>
        <li><b>适应</b>：选择将远程屏幕缩放以适应标签页 (开) 或以实际大小查看 (关)。</li>
        <li><b>复制 &amp; 粘贴</b>：与 mstsc 一样，可使用 ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")} 在本机和远程电脑之间交换文本、图片以及<b>文件和文件夹</b> (会话选项“共享剪贴板”)。在远程端复制的文件会在粘贴时下载，工具栏中显示进度。</li>
        <li>键盘：本机的键盘类型和布局 (例如韩文 103/106 键) 会原样传递到远程端，因此右侧 Shift/Ctrl/Alt 以及韩/汉字键的行为与 mstsc 相同。Num Lock 和 Caps Lock 状态也会同步到服务器，因此无需再次按 Num Lock，即可在登录界面使用数字键盘输入。</li>
        <li>工具栏：发送 ${kbd("Ctrl+Alt+Del")}、Windows 键、键入剪贴板 (将剪贴板文本作为按键发送)、用 mstsc 打开。</li>
        <li>首次连接时需要验证服务器证书指纹；信任后将不再询问。</li>
        <li>当您在查看其他标签页或窗口最小化时，该 RDP 标签页会停止绘制，返回时一次性获取整个屏幕。</li>
        <li><b>VNC 速度</b>：在工具栏的“画质”中选择 快速 (默认：较低色彩/画质，最大压缩)、普通或清晰 (立即生效，无需断开)。开启“状态”可查看服务器使用的编码和每秒接收的数据量。如果只出现 Raw 或 Hextile，说明服务器没有使用压缩。</li>
        <li>VNC 缓慢时，原因通常在于<b>服务器设置</b>。对于 TightVNC Server：在服务器设置 → Server 选项卡中，将 <b>Screen polling cycle</b> 从 1000ms 降到 30–50ms，关闭 <b>Grab transparent windows</b>，如已安装则启用 <b>镜像驱动 (DFMirage)</b>。去掉桌面壁纸也很有帮助。在 4K 等大屏幕上，TightVNC 可能会延迟数十秒 (在一台电脑上的实测：TightVNC 延迟 34–46 秒，UltraVNC 接近实时)。此时请使用 <b>UltraVNC Server</b>，并在其 Capture 选项卡中开启 Windows 桌面复制 (DDengine)。</li>
        <li><b>VNC 文件传输</b>：VNC 协议本身没有文件传输 (TightVNC 和 UltraVNC 各自使用不同的扩展)。点击工具栏的“文件传输”，会在旁边打开到同一台电脑的 SFTP 文件窗格。远程电脑需要运行 SSH 服务器；如未运行，可用“AI”→“通过 SSH 连接以便 AI 执行命令…”中的脚本启用。</li>
        <li>内置 RDP 不使用 mstsc 的图形加速 (H.264)，因此在屏幕变化较多时可能比 mstsc 慢。这种情况下请使用“用 mstsc 打开”。</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "工具 · 文件服务器",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>SSH 网关</b>：在 RDP、VNC 或 Telnet 会话编辑器中，选择一个已保存的 SSH 会话作为网关，即可通过该服务器访问防火墙后的设备。</li>
        <li><b>代理</b>：在会话编辑的“代理”中，可像 PuTTY 的 Connection → Proxy 一样选择 SOCKS 4/4a、SOCKS 5、HTTP CONNECT、Telnet（用命令连接）或本地命令。SSH、SFTP、Telnet、FTP/FTPS、RDP、VNC 以及该会话的资源监视器都会经过代理。代理登录从凭据保管库中选择，还可设置不经过代理的主机（*.corp.local、10.0.0.0/8）、DNS 解析位置以及是否显示诊断信息。经代理连接时 FTP 使用被动 (PASV) 模式。从 PuTTY、KiTTY 导入的会话会一并导入代理设置（不含密码）。</li>
        <li><b>SSH 隧道</b>：顶部的工具 → SSH 隧道。保存 本地端口 → SSH 服务器 → 目标地址 的转发，并可随时开启和关闭。</li>
        <li><b>网络工具</b>：ping、TCP 端口检查 (多个端口和范围)、DNS 查询。</li>
        <li><b>文件服务器</b>：顶部的文件服务器按钮可通过 FTP、TFTP 或 HTTP 临时共享本机上的文件夹 (例如用于上传设备 OS 镜像)。</li>
      </ul>`,
  },
  {
    id: "security",
    title: "凭据 · 安全",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>凭据库</b> (顶部的钥匙按钮)：将密码和 SSH 密钥保存在 Windows 凭据管理器中，供会话编辑器使用。已保存的密码绝不会显示在屏幕上。</li>
        <li><b>主密码</b> (设置 → 安全)：在启动时以及您离开一段时间后锁定应用。</li>
        <li>SSH/SFTP 主机密钥会与 <code>~/.ssh/known_hosts</code> 进行核对；未知密钥会显示指纹供确认。密钥已更改时会阻止连接。</li>
      </ul>`,
  },
  {
    id: "update",
    title: "更新",
    icon: "RefreshCw",
    body: `
      <p>启动时以及运行期间<b>每 30 分钟</b>（离开一段时间后回到窗口时也会）在 <b>GitHub</b>（github.com/NijG/bananaconn）上检查新版本。因安全策略无法访问 GitHub 的电脑，请在“设置 → 更新”中指定 <b>NAS 更新文件夹</b>（存放新版本的共享文件夹），无法访问 GitHub 时会检查该文件夹。发现新版本后会弹出<b>询问是否立即更新的窗口</b>。点击“立即更新”后应用会关闭，安装完成后重新打开（已打开的连接会断开）。点击“稍后”后，也可以随时用状态栏右侧的<b>更新</b>按钮安装。该窗口默认选中“稍后”，因此在终端中输入的 Enter 不会启动更新。</p>
      <p><b>提示“密码不正确”而失败时</b>：Windows 会使用当前登录的 Windows 账户连接共享文件夹，即使共享允许匿名 (来宾) 读取，也不会回退到来宾访问。请在资源管理器中打开更新文件夹，输入 NAS 账户并勾选“记住我的凭据”，或在 设置 → 更新 的 <b>NAS 账户</b> 中从凭据库选择一个账户。之后应用将使用该账户登录。</p>
      <p>只会安装由构建电脑签名的文件，因此他人放入共享文件夹的文件不会被安装。也可以通过“立即检查”马上检查。</p>`,
  },
  {
    id: "keys",
    title: "键盘快捷键",
    icon: "Keyboard",
    body: `
      <p>所有快捷键都可以在<b>设置 → 键盘快捷键</b>（或主页上的“键盘快捷键设置”）中查看和修改。没有快捷键的操作（分屏、第 n 个标签页、开启日志等）以及代码片段和宏也可以新指定快捷键；用每个操作的“默认值”或“全部恢复默认值”即可还原。下表为默认值。</p>
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>本帮助 (在终端内会发送给远程程序)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>新建会话</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>转到快速连接</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>下一个 / 上一个标签页</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>关闭标签页</td></tr>
        <tr><td>双击标签页</td><td>再次打开同一会话</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>在终端中查找</td></tr>
        <tr><td>${kbd("Ctrl")}+滚轮</td><td>终端字号</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>折叠侧边栏</td></tr>
        <tr><td colspan="2"><b>在会话列表中</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>连接 / 编辑 / 删除 (选中多个时应用于全部)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>复制 / 粘贴会话</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+单击、${kbd("Ctrl+A")}</td><td>多选</td></tr>
      </table>`,
  },
];
