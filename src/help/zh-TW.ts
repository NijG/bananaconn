// Traditional Chinese (zh-TW) version of the in-app usage guide (same sections, ids and icons as help.ts).

import type { HelpSection } from "../help";
import { icon } from "../icons";
import { esc } from "../ui";

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

export const SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "開始使用",
    icon: "Sparkles",
    body: `
      <p>BananaConn 是一套遠端存取工具，將 SSH、Telnet、序列 (COM)、SFTP、FTP/FTPS、RDP 與 VNC 連線集中在分頁中使用。</p>
      <h4>立即連線 (快速連線)</h4>
      <ol>
        <li>在左上角選擇通訊協定 (SSH、Telnet …)。</li>
        <li>在旁邊的方塊中輸入 <code>user@host:port</code> 並按 ${kbd("Enter")}。例如：<code>root@10.0.0.5</code>、<code>admin@192.168.0.1:2222</code></li>
        <li>序列連線請輸入 <code>COM3</code> 或 <code>COM3:115200</code>。</li>
      </ol>
      <h4>儲存為工作階段</h4>
      <p>使用工作階段清單中的 ${icon("Plus", 13)} 按鈕 (${kbd("Ctrl+Shift+N")}) 儲存連線資訊，之後按兩下或按 ${kbd("Enter")} 即可連線。其他程式中儲存的連線，可以透過<a data-goto="import">匯入</a>一次搬過來。</p>
      <h4>介面語言</h4>
      <p>設定最上方的<b>介面語言</b>可將畫面切換為 한국어、English、日本語、简体中文、繁體中文、Tiếng Việt、Español、Français 或 Deutsch (立即生效且不會中斷連線；使用說明與更新說明也會一併切換)。在您選擇之前，應用程式會依照 Windows 顯示語言；選擇之後，一律以您的選擇為準。</p>`,
  },
  {
    id: "sessions",
    title: "工作階段清單",
    icon: "Server",
    body: `
      <ul>
        <li><b>資料夾</b>：在編輯工作階段中以斜線輸入資料夾，例如 <code>Prod/Web servers</code>，即可建立子資料夾。也可以將工作階段拖曳到資料夾上來移動。</li>
        <li><b>排序與順序</b>：工作階段清單上方的排序按鈕可選擇依名稱（AP2 在 AP10 之前）、依位址（IP 依數字比較）、依最近連線或自訂。將工作階段拖曳到另一個工作階段的上方或下方即可放到該處；資料夾也可用同樣方式調整順序或移入其他資料夾。調整順序後會切換為自訂排序並保留該順序。${kbd("Alt+Up")} / ${kbd("Alt+Down")} 可將所選工作階段上下移動一格，資料夾選單中的「將此資料夾內容依名稱/位址排序」可一次整理。</li>
        <li><b>搜尋</b>：在上方的搜尋方塊中輸入名稱、主機、使用者或備註的一部分。</li>
        <li><b>多重選取</b>：${kbd("Ctrl")}+按一下可逐一選取，${kbd("Shift")}+按一下可選取範圍。也可以使用 ${kbd("Shift+↑/↓")} 與 ${kbd("Ctrl+A")}。${kbd("Esc")} 會清除選取。</li>
        <li><b>批次作業</b>：選取多個後按右鍵 → 批次修改 (${kbd("F2")}：使用者、連接埠、認證、資料夾、按鍵輸入方式)、移到資料夾、刪除 (${kbd("Del")})、全部連線 (${kbd("Enter")})。</li>
        <li><b>複製與貼上</b>：選取工作階段後按 ${kbd("Ctrl+C")}，再選取目標資料夾中的工作階段並按 ${kbd("Ctrl+V")}。每次貼上都會建立名為「名稱 (2)」、「名稱 (3)」的新工作階段。按右鍵 → 複製一份 也有相同效果。</li>
        <li><b>編輯</b>：${kbd("F2")} 或按右鍵 → 編輯。</li>
      </ul>`,
  },
  {
    id: "import",
    title: "從其他程式匯入",
    icon: "Download",
    body: `
      <p>從工作階段清單上方的 ${icon("Download", 13)} 按鈕中選擇。匯入前會先顯示預覽清單，已存在的工作階段會被略過。<b>不會匯入密碼</b> (各程式都以自己的金鑰加密密碼)。請在第一次連線時輸入，或從認證保管庫指定。</p>
      <table class="help-table">
        <tr><th>程式</th><th>要選擇的項目</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (可攜版：位於執行檔旁)</td></tr>
        <tr><td>SecureCRT</td><td>工作階段資料夾 <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (包含資料夾結構、記錄檔名稱與自動記錄設定)，或以 檔案 → 匯出設定 產生的 XML</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (若已開啟整個檔案加密，請先關閉並儲存)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>直接讀取這台電腦的設定</td></tr>
        <tr><td>WinSCP</td><td>這台電腦的設定，若沒有則選擇 <code>WinSCP.ini</code></td></tr>
        <tr><td>Xshell</td><td><code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code> 資料夾</td></tr>
        <tr><td>RDCMan</td><td><code>.rdg</code> 檔案</td></tr>
        <tr><td>遠端桌面</td><td>含有 <code>.rdp</code> 檔案的資料夾 (包含子資料夾)</td></tr>
        <tr><td>CSV</td><td>第一行為欄位名稱：Name, Protocol, Host, Port, Username, Folder (以逗號、分號或 Tab 分隔)</td></tr>
      </table>
      <p>在不同的 BananaConn 安裝之間，請使用同一選單中的<b>匯出/匯入工作階段備份 (JSON)</b>。備份中除了工作階段，還包含空資料夾、片段/巨集與 SSH 通道。在同一台電腦上還原時，認證的關聯也會保留；即使所有工作階段都已存在，也可以只還原缺少的資料夾、片段與通道。SSH 通道與安全性相關選項 (忽略憑證錯誤、連接埠轉送、記錄檔位置等) 只有在開啟「一併匯入安全性相關選項」時才會匯入。</p>`,
  },
  {
    id: "tabs",
    title: "分頁與分割畫面",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>關閉分頁</b>：${kbd("Ctrl+F4")} 或 ${kbd("Ctrl+Shift+W")}，或以滑鼠中鍵按一下分頁。在確認視窗中按 ${kbd("Enter")} 即可關閉；勾選「不再詢問」後下次就會略過 (可在設定中重新開啟)。</li>
        <li><b>再開啟一次相同的工作階段</b>：在分頁上<b>按兩下</b>。適合為了監控而對同一部設備建立第二條連線。</li>
        <li><b>切換分頁</b>：${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}。分頁很多時，在分頁列上捲動滑鼠滾輪即可左右移動。拖曳分頁可調整順序。</li>
        <li><b>分割畫面</b>：上方的 單一畫面 / 左右分割 / 上下分割 / 四分割 按鈕。將分頁拖曳到想要的窗格中。</li>
        <li>分頁上的圓點顏色代表通訊協定，閃爍表示連線中，紅色表示發生錯誤。</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "終端機 (SSH · Telnet · 序列)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>複製與貼上</b>：拖曳選取即會立即複製，按右鍵即可貼上 (可在設定中變更)。${kbd("Ctrl+C")} 只有在有選取內容時才會複製，否則會傳送給設備。</li>
        <li><b>字型大小</b>：${kbd("Ctrl")}+滑鼠滾輪，或工具列中的 ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)}。</li>
        <li><b>尋找</b>：${kbd("Ctrl+Shift+F")}。</li>
        <li><b>按鍵輸入方式</b>：若在 Cisco IOS 等設備上按 Delete、Home 或 End 會出現 <code>~</code>，請將工具列切換為「按鍵：設備」(Delete=Ctrl-D、Home=Ctrl-A、End=Ctrl-E)。預設值可在編輯工作階段中設定。</li>
        <li><b>序列</b>：在編輯工作階段中設定 COM 連接埠 (「尋找連接埠」)、速度、同位檢查與流量控制。工具列中的 Break 會傳送 Break 訊號。貼上多行內容或用工具列的「傳送文字檔」傳送設定時，會逐行傳送：設備每接收一行並重新顯示提示字元，就立即傳送下一行，因此快的設備很快收完，慢的設備也不會漏字元。傳送時會顯示進度；按 ${kbd("Ctrl+C")}、Break 或進度框中的「停止」可放棄其餘的行。對不回顯輸入的設備，可在 設定 → 終端機 中改用固定延遲。經主控台伺服器的 Telnet 工作階段在工作階段編輯中開啟「主控台伺服器連線」後，也依同樣方式傳送。USB 序列轉接器被拔出時，分頁會等待該連接埠，重新插入後自動連線。連接埠輸入輸出使用快速方式，按鍵不會被等待讀取阻擋；如驅動程式有問題，可在 設定 → 終端機 中改為相容模式。</li>
        <li><b>醒目提示輸出關鍵字</b>：ERROR·FAIL 以紅色、WARN 以黃色、OK·SUCCESS 以綠色顯示。</li>
        <li><b>畫面繪製</b> (設定 → 終端機)：「自動」會在有顯示卡的電腦上以 GPU (WebGL) 繪製，加快大量輸出的速度；在沒有顯示卡的伺服器與遠端工作階段中則使用標準繪製方式。只有畫面上可見的終端機會使用 GPU。</li>
        <li><b>片段與巨集</b>：將常用命令儲存在工具列的片段中，並使用「錄製」擷取輸入後重播。</li>
        <li><b>檔案</b> (SSH)：工具列中的檔案按鈕會在旁邊開啟同一部伺服器的 SFTP 窗格。</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "同步輸入",
    icon: "Radio",
    body: `
      <p>開啟上方的<b>同步輸入</b>後，在目前終端機中輸入的按鍵會傳送到<b>所有已連線的終端機分頁</b> (包含不在畫面上的分頁)。接收的分頁會有閃爍的圓點。可用來將相同命令傳送到多部設備，使用完畢後請務必關閉。各分頁會依照自己的按鍵輸入方式 (標準/設備) 傳送 Delete、Home 與 End。</p>`,
  },
  {
    id: "log",
    title: "工作階段記錄",
    icon: "ScrollText",
    body: `
      <p>使用工具列中的<b>記錄</b>按鈕開始與停止。開始時可以確認並修改檔案名稱 (可在設定中關閉)，按一下狀態列中的「記錄中」會開啟該檔案所在的資料夾。</p>
      <h4>檔案名稱替代字元 (與 SecureCRT 相同)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> 工作階段名稱</td><td><code>%H</code> 主機</td><td><code>%U</code> 使用者</td><td><code>%P</code> 連接埠</td></tr>
        <tr><td><code>%Y</code> 年 (4 位數)</td><td><code>%M</code> 月</td><td><code>%D</code> 日</td><td><code>%%</code> % 符號</td></tr>
        <tr><td><code>%h</code> 時</td><td><code>%m</code> 分</td><td><code>%s</code> 秒</td><td><code>%t</code> 毫秒</td></tr>
      </table>
      <p>例如：<code>D:\\Checks\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\Checks\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>。不存在的資料夾會自動建立。相對路徑會位於 Documents\\BananaConn\\logs 之下。</p>
      <ul>
        <li><b>若檔案已存在</b>：接續寫入 / 覆寫 / 新檔案 (-2、-3 …)。</li>
        <li><b>每行開頭</b>：例如 <code>[%h:%m:%s] </code>，為每一行加上時間戳記。</li>
        <li><b>開始時 / 結束時</b>：要寫入檔案的文字 (可使用替代字元)。</li>
        <li><b>過了午夜後改用新檔案</b>：若名稱中含有 <code>%D</code>，日期變更時會改用新檔案繼續記錄。</li>
        <li><b>連線時自動記錄</b>：適用於所有工作階段 (設定 → 記錄) 或個別工作階段 (編輯工作階段 → 記錄 → 為此工作階段個別指定)。</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "片段 · 巨集",
    icon: "Circle",
    body: `
      <p>可以儲存常用命令 (片段)，或錄製在終端機中輸入的按鍵並原封不動地再次傳送 (巨集)。</p>
      <p><b>各 OS 的內建片段</b>：提供 Linux、AIX、HP-UX、Solaris、Windows、Cisco IOS · NX-OS · ASA、FortiGate、Aruba、Juniper 與 Huawei 的常用唯讀檢查 (不會變更任何內容的命令)。片段清單會優先顯示您自己的片段以及該分頁辨識出的 OS 的片段；其他系統可在「… 片段」中一鍵找到。在管理程式碼片段中可以編輯、刪除，或變更其 OS 分類。</p>
      <p><b>危險命令</b>：片段或巨集傳送的每一行都會依 設定 → 危險命令 中的規則檢查。變更時間或 NTP 的命令 (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) 會被<b>封鎖</b>，不會傳送；重新開機、刪除、格式化或變更設備組態等命令需要先在<b>警告</b>中確認。傳送時會開啟該分頁的記錄，每次嘗試、取消與封鎖都會寫入記錄資料夾中的 <code>risky-commands.log</code>。以 <code>;</code>、<code>&amp;&amp;</code> 串接的命令，<code>sudo</code>、<code>su -c</code>、<code>bash -c</code>、<code>eval</code> 中的命令，以及以行尾 <code>\\</code> 接續的命令也會檢查。含有 Tab 自動完成或游標移動鍵 (←→、Home、命令記錄 ↑↓) 的巨集會發出警告，因為無法得知實際傳送的命令。自己輸入的命令也會檢查：按 Enter 時，會用相同的規則檢查畫面上顯示的命令列（包括命令記錄 ↑↓ 與 Tab 自動完成的結果）。vi、less 等全螢幕程式中不檢查，可在設定 → 危險指令中關閉此檢查。</p>
      <p><b>輸入指令時的上色與自動完成</b>：提示字元後正在輸入的指令會依指令、選項、字串、路徑與連接符號上色，符合危險指令規則時在按 Enter 之前變為紅色。根據先前執行過的指令（僅保存在本機）與程式碼片段，以灰色建議指令的其餘部分：<kbd>→</kbd> 或 <kbd>End</kbd> 輸入全部，<kbd>Ctrl</kbd>+<kbd>→</kbd> 逐字輸入。<kbd>Tab</kbd> 仍是伺服器本身的自動完成。<kbd>Ctrl</kbd>+<kbd>Space</kbd> 開啟候選清單（↑↓ 選擇，Enter 或 Tab 輸入，Esc 關閉）。候選項依序來自執行記錄、程式碼片段、已辨識裝置的指令辭典（Linux、AIX、HP-UX、Solaris、Windows、Cisco、FortiGate、Aruba、Juniper、Huawei），以及開啟資源監視器的 Unix 伺服器 PATH 中的程式名稱。這些名稱透過監視器連線只讀取一次，不會在終端機中輸入任何內容。命令列從畫面讀取，因此不顯示的密碼不會被記錄，危險指令以及含有密碼或權杖的指令（<code>mysql -p…</code>、<code>--password=…</code>、<code>TOKEN=…</code>）既不記錄也不建議。輸入錯誤的記錄可在候選清單中按 <kbd>Shift</kbd>+<kbd>Delete</kbd> 刪除。可在設定 → 終端機中分別關閉，並清除命令記錄。</p>
      <h4>建立與傳送片段</h4>
      <ol>
        <li>在終端機工具列中：<b>片段</b> → <b>管理程式碼片段…</b> → <b>新增片段</b>。</li>
        <li>輸入名稱與要傳送的內容。多行內容會以 Enter 逐行傳送 (例如 <code>terminal length 0</code> 的下一行接著 <code>show running-config</code>)。</li>
        <li>開啟<b>傳送後按 Enter 執行</b>時，最後一行會立即執行；關閉時，命令只會輸入並等待。</li>
        <li>要傳送時，按一下工具列中的<b>片段</b>並從清單中選擇。</li>
      </ol>
      <h4>錄製與播放巨集</h4>
      <ol>
        <li>按一下終端機工具列中的<b>錄製</b>；按鈕會變成<b>結束錄製</b>，之後輸入的每個按鍵都會原樣儲存 (包含 Enter、Tab、Ctrl 鍵、方向鍵與輸入法輸入)。</li>
        <li>照常在設備上輸入命令。傳送的片段也會一併錄進巨集。</li>
        <li>按一下<b>結束錄製</b>並命名後儲存。</li>
        <li>要重播時，從工具列的<b>片段</b>清單中選擇標示為<b>巨集</b>的項目。錄製的按鍵會依照輸入時的樣子依序傳送。</li>
      </ol>
      <ul>
        <li><b>同時操作多部設備</b>：在上方的<b>同步輸入</b>開啟時傳送片段或巨集，就會傳送到所有已連線的終端機分頁。</li>
        <li><b>不要錄製密碼</b>：巨集會原樣儲存輸入的按鍵，因此錄製期間輸入的密碼也會被儲存。</li>
        <li>可以在<b>管理程式碼片段…</b>中檢視巨集內容 (⏎ = Enter、⇥ = Tab、^C = Ctrl+C)。可以重新命名與刪除，但無法編輯按鍵；要變更請重新錄製。</li>
        <li>片段與巨集儲存在這台電腦上，由所有工作階段共用。</li>
      </ul>`,
  },
  {
    id: "ai",
    title: "AI（產生指令 · 說明 · 對話 · 分析）",
    icon: "Sparkles",
    body: `
      <p>連接雲端 AI（API 金鑰）、訂閱 CLI 或本機的本地 LLM，協助終端機工作。在設定 → AI 中新增服務並選擇預設使用的 AI。</p>
      <ul>
        <li><b>連接方式</b>：API 金鑰（Anthropic Claude、OpenAI、Google Gemini、OpenAI 相容伺服器）、訂閱 CLI（Claude Code、Codex CLI、Gemini CLI：在本機安裝並登入一次後，即可用您的訂閱回答）、本地 LLM（Ollama，或 LM Studio、llama.cpp、vLLM 等 OpenAI 相容伺服器）。API 金鑰儲存在認證保管庫中；「載入清單」取得模型，「測試連線」試用服務。</li>
        <li><b>產生指令</b>（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>）：用文字描述要做的事，即可取得一條適合所辨識裝置或系統的指令。再按一次 Enter 會放入輸入列（不會執行），由您自己按 Enter 執行。危險指令規則同樣適用：被封鎖的指令（修改時間、NTP 等）甚至不會放入輸入列。</li>
        <li><b>說明輸出</b>（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>）：說明所選文字（若未選取則為畫面上最近的輸出）的意義、可能原因與後續步驟。</li>
        <li><b>AI 對話</b>（<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>）：在終端機右側開啟對話窗格。以「附加選取內容」一併傳送輸出；回答中每行指令旁的按鈕可將其放入輸入列。</li>
        <li><b>設定與記錄分析</b>：對話窗格中的檔案按鈕可選擇設定或記錄檔案進行檢查（安全問題、危險設定）或分析（錯誤、異常跡象）。網路裝置可透過裝置按鈕 →「用 AI 檢查設定」直接檢查 running-config。</li>
        <li><b>傳送的內容</b>：傳送到雲端 AI 之前，會顯示將傳送的內容並請您確認（每個對話可選擇「不再詢問」）。密碼、金鑰與權杖（<code>password=…</code>、<code>-p…</code>、<code>enable secret</code>、<code>snmp-server community</code>、私密金鑰等）一律會隱藏；開啟設定後，IP 位址與主機名稱也會替換為 IP_1、HOST_1 等再傳送，回答中會還原為實際值。本地 LLM 不會離開本機，因此不會詢問或隱藏。傳送公司設備資訊給外部 AI 之前，請確認公司的安全政策。</li>
        <li>訂閱 CLI：Claude Code 在關閉所有工具（不執行指令、不讀取檔案）的狀態下於空資料夾中執行，Codex 在唯讀沙箱中執行。應用程式不會處理您的登入資訊。</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "設備辨識 · CPU · 記憶體",
    icon: "Activity",
    body: `
      <p>以 SSH 或 Telnet 連線時，會透過另一條監控連線自動辨識設備類型，並在狀態列顯示設備名稱與 CPU/記憶體 (伺服器還會顯示磁碟)。不會在終端機中輸入任何內容。</p>
      <p>支援的設備：<b>Cisco</b> IOS · IOS-XE · NX-OS · ASA、<b>Fortinet</b> FortiGate、<b>Aruba</b> AOS-CX · AOS-Switch (ProCurve) · 無線控制器、<b>Juniper</b> Junos、<b>Huawei</b> VRP，以及執行 <b>Linux (Red Hat 等)</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b> 的伺服器。</p>
      <ul>
        <li><b>設備按鈕</b>：辨識完成後，終端機工具列中會出現顯示設備名稱的按鈕。按一下即可一次輸入該設備的常用 show 命令 (介面、路由、VLAN、HA、錯誤記錄等)。不包含任何會變更設定的命令。</li>
        <li><b>備份設定</b>：網路設備可透過 設備按鈕 →「備份設定」將 running-config (FortiGate 為 <code>show</code>) 儲存為 <code>devicename_datetime.cfg</code> 檔案。由於是透過監控連線讀取，不會干擾您正在使用的終端機。若設備因權限不足而拒絕，或未收到設定的結尾 (IOS 的 <code>end</code>、Huawei 的 <code>return</code> 等)，就不會儲存。</li>
        <li><b>自動切換按鍵輸入方式</b>：辨識出網路設備時，尚未選擇按鍵輸入方式的工作階段會切換為設備方式 (Delete=Ctrl-D、Home=Ctrl-A、End=Ctrl-E)。</li>
        <li><b>使用量最高的處理程序</b>：按一下狀態列中的 CPU/記憶體，即可查看 CPU 與記憶體使用量前 10 名的處理程序以及磁碟清單 (Linux)。</li>
        <li>監控會額外使用一次登入。<b>即使對同一部設備開啟多個分頁，也只會使用一條監控連線</b> (以節省設備的 VTY 線路)。</li>
        <li>Linux 每 2 秒 (以 Telnet 連線時每 10 秒)、網路設備每 15 秒、AIX/HP-UX/Solaris 每 10 秒讀取一次。伺服器的 shell 歷程記錄 (<code>~/.sh_history</code> 等) 中不會留下監控命令。當畫面上沒有該設備的分頁或視窗最小化時會暫停 (為了不讓登入中斷，每 5 分鐘只確認一次設備)，再次顯示時會立即讀取。</li>
        <li>若出現「按一下以登入」，請按一下並輸入監控用的密碼 (不會儲存)。若不知道密碼，監控連線會在傳送使用者名稱之前中斷，因此設備上不會留下登入失敗的記錄。對於不需密碼即可登入的 Telnet 設備，請將密碼留空並開始。若登入後設備還會詢問一次性驗證碼之類的內容，則不會進行監控。若要關閉：設定 → 工作階段。</li>
      </ul>`,
  },
  {
    id: "files",
    title: "檔案傳輸 (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>左側是您的電腦，右側是伺服器。將項目拖曳到另一側，或按一下傳輸按鈕。資料夾會連同其內容一起傳送。</li>
        <li>若已有同名檔案，會詢問是否覆寫。傳輸時會顯示進度，並可取消。</li>
        <li><b>TFTP</b>：將工作階段類型選為 TFTP (或在快速連線中選擇) 即可開啟 TFTP 分頁。TFTP 沒有登入與資料夾清單，因此請輸入<b>伺服器上的檔案名稱</b>並按一下「取得」，或選擇您電腦上的檔案並按一下「傳送」。區塊大小「自動」適用於大多數設備，不支援選項的舊伺服器會自動改用 512。若要讓設備將檔案傳送到您的電腦 (例如 <code>copy running-config tftp:</code>)，請開啟上方「伺服器」按鈕中的 <b>TFTP 伺服器</b>。</li>
        <li>透過 SFTP 傳送資料夾時會一次傳輸 4 個檔案，對於含有大量小檔案的資料夾 (尤其是遠距離連線) 會快很多。FTP 因為伺服器連線數限制而一次傳送一個，但傳輸期間仍可繼續瀏覽資料夾。</li>
        <li>在伺服器上的文字檔按兩下即可在內建編輯器中開啟；儲存時會直接寫回伺服器。</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "遠端桌面 (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>畫面大小</b>：若工作階段的解析度為「自動」，會符合分頁大小。調整視窗大小時遠端解析度也會跟著改變；若伺服器不支援即時調整大小，會自動以新的大小重新連線。</li>
        <li><b>符合</b>：選擇要將遠端畫面縮放以符合分頁 (開啟)，或以實際大小檢視 (關閉)。</li>
        <li><b>複製與貼上</b>：與 mstsc 一樣，可使用 ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")} 在您的電腦與遠端電腦之間交換文字、圖片以及<b>檔案與資料夾</b> (工作階段選項「共用剪貼簿」)。在遠端複製的檔案會在貼上時下載，進度會顯示在工具列中。</li>
        <li>鍵盤：您電腦的鍵盤類型與配置 (例如韓文 103/106 鍵) 會原樣傳遞到遠端，因此右側 Shift/Ctrl/Alt 以及韓文/漢字鍵的行為與 mstsc 相同。Num Lock 與 Caps Lock 的狀態也會同步到伺服器，因此在登入畫面中不必再按一次 Num Lock 就能使用數字鍵台。</li>
        <li>工具列：傳送 ${kbd("Ctrl+Alt+Del")}、Windows 鍵、輸入剪貼簿 (將剪貼簿文字以按鍵方式傳送)、以 mstsc 開啟。</li>
        <li>第一次連線時需確認伺服器憑證指紋；信任後就不會再詢問。</li>
        <li>當您檢視其他分頁或視窗最小化時，該 RDP 分頁會停止繪製，回來時再一次取得完整畫面。</li>
        <li><b>VNC 速度</b>：在工具列的「畫質」中選擇 快速 (預設：降低色彩/畫質並盡量壓縮)、一般 或 清晰 (立即套用且不會中斷連線)。開啟「狀態」即可查看伺服器使用的編碼與每秒接收的資料量。若只出現 Raw 或 Hextile，表示伺服器沒有使用壓縮。</li>
        <li>VNC 很慢時，原因通常在於<b>伺服器設定</b>。以 TightVNC Server 為例：在伺服器設定 → Server 分頁中，將 <b>Screen polling cycle</b> 從 1000ms 降到 30–50ms、關閉 <b>Grab transparent windows</b>，若已安裝則啟用 <b>mirror driver (DFMirage)</b>。移除桌面桌布也很有幫助。在 4K 等大型畫面上，TightVNC 可能會延遲數十秒 (在某台電腦上實測：TightVNC 延遲 34–46 秒，UltraVNC 接近即時)。此時請使用 <b>UltraVNC Server</b>，並在其 Capture 分頁中開啟 Windows 桌面複製 (DDengine)。</li>
        <li>內建 RDP 不使用 mstsc 的圖形加速 (H.264)，因此在畫面變化大時可能比 mstsc 慢。這種情況請使用「以 mstsc 開啟」。</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "工具 · 檔案伺服器",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>SSH 閘道</b>：在 RDP、VNC 或 Telnet 的編輯工作階段中，選擇已儲存的 SSH 工作階段作為閘道，即可經由該伺服器連到防火牆後方的設備。</li>
        <li><b>Proxy</b>：在編輯工作階段的「Proxy」中，可像 PuTTY 的 Connection → Proxy 一樣選擇 SOCKS 4/4a、SOCKS 5、HTTP CONNECT、Telnet（用指令連線）或本機指令。SSH、SFTP、Telnet、FTP/FTPS、RDP、VNC 以及該工作階段的資源監視器都會經過 Proxy。Proxy 登入從認證保管庫中選擇，還可設定不經過 Proxy 的主機（*.corp.local、10.0.0.0/8）、DNS 查詢位置以及是否顯示診斷訊息。經 Proxy 連線時 FTP 使用被動 (PASV) 模式。從 PuTTY、KiTTY 匯入的工作階段會一併匯入 Proxy 設定（不含密碼）。</li>
        <li><b>SSH 通道</b>：上方的工具 → SSH 通道。儲存 本機連接埠 → SSH 伺服器 → 目標位址 的轉送，並可開啟與關閉。</li>
        <li><b>網路工具</b>：ping、TCP 連接埠檢查 (多個連接埠與範圍)、DNS 查詢。</li>
        <li><b>檔案伺服器</b>：上方的檔案伺服器按鈕可透過 FTP、TFTP 或 HTTP 暫時共用這台電腦上的資料夾 (例如上傳設備的 OS 映像檔)。</li>
      </ul>`,
  },
  {
    id: "security",
    title: "認證 · 安全性",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>認證保管庫</b> (上方的鑰匙按鈕)：將密碼與 SSH 金鑰儲存在 Windows 認證管理員中，供編輯工作階段使用。已儲存的密碼絕不會顯示在畫面上。</li>
        <li><b>主密碼</b> (設定 → 安全性)：在應用程式啟動時以及離開一段時間後鎖定。</li>
        <li>SSH/SFTP 主機金鑰會與 <code>~/.ssh/known_hosts</code> 比對；未知的金鑰會顯示指紋供確認。金鑰變更時會封鎖連線。</li>
      </ul>`,
  },
  {
    id: "update",
    title: "更新",
    icon: "RefreshCw",
    body: `
      <p>啟動時以及執行期間<b>每 30 分鐘</b>（離開一段時間後回到視窗時也會）在 <b>GitHub</b>（github.com/NijG/bananaconn）上檢查新版本。因安全性原則無法連線到 GitHub 的電腦，請在「設定 → 更新」中指定 <b>NAS 更新資料夾</b>（存放新版本的共用資料夾），無法連線到 GitHub 時會檢查該資料夾。發現新版本後會跳出<b>詢問是否立即更新的視窗</b>。按「立即更新」後應用程式會關閉，安裝完成後重新開啟（已開啟的連線會中斷）。按「稍後」後，也可以隨時用狀態列右側的<b>更新</b>按鈕安裝。該視窗預設選取「稍後」，因此在終端機中輸入的 Enter 不會啟動更新。</p>
      <p><b>出現「密碼不正確」而失敗時</b>：Windows 會以目前登入的 Windows 帳戶連線到共用資料夾，即使共用資料夾允許匿名 (來賓) 讀取，也不會改用來賓身分。請在檔案總管中開啟更新資料夾，輸入 NAS 帳戶並勾選「記住我的認證」，或在 設定 → 更新 的 <b>NAS 帳戶</b> 中從認證保管庫選擇帳戶。之後應用程式就會以該帳戶登入。</p>
      <p>只會安裝由建置電腦簽章的檔案，因此他人放到共用資料夾中的檔案不會被安裝。也可以使用「立即檢查」馬上確認。</p>`,
  },
  {
    id: "keys",
    title: "快速鍵",
    icon: "Keyboard",
    body: `
      <p>所有快速鍵都可以在<b>設定 → 快速鍵</b>（或首頁上的「快速鍵設定」）中檢視和變更。沒有快速鍵的動作（分割畫面、第 n 個分頁、開啟記錄等）以及程式碼片段和巨集也可以新指定快速鍵；用每個動作的「預設值」或「全部還原為預設值」即可還原。下表為預設值。</p>
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>本使用說明 (在終端機內會傳給遠端程式)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>新增工作階段</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>移至快速連線</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>下一個 / 上一個分頁</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>關閉分頁</td></tr>
        <tr><td>在分頁上按兩下</td><td>再開啟一次相同的工作階段</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>在終端機中尋找</td></tr>
        <tr><td>${kbd("Ctrl")}+滾輪</td><td>終端機字型大小</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>摺疊側邊欄</td></tr>
        <tr><td colspan="2"><b>在工作階段清單中</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>連線 / 編輯 / 刪除 (選取多個時套用到全部)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>複製 / 貼上工作階段</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+按一下、${kbd("Ctrl+A")}</td><td>多重選取</td></tr>
      </table>`,
  },
];
