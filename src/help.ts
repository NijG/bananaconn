// In-app usage guide (F1 or the "?" button): sections on the left, a search
// box that filters them, and the content on the right.

import { language } from "./i18n";
import { icon } from "./icons";
import { esc, modal } from "./ui";

export interface HelpSection {
  id: string;
  title: string;
  icon: string;
  /** HTML (trusted, written here). */
  body: string;
}

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

const KO_SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "시작하기",
    icon: "Sparkles",
    body: `
      <p>BananaConn은 SSH, Telnet, 시리얼(COM), SFTP, FTP/FTPS, RDP, VNC 접속을 탭 하나에 모아 쓰는 원격 접속 도구입니다.</p>
      <h4>바로 접속하기 (빠른 연결)</h4>
      <ol>
        <li>상단 왼쪽의 프로토콜(SSH, Telnet …)을 고릅니다.</li>
        <li>옆 칸에 <code>사용자@호스트:포트</code>를 입력하고 ${kbd("Enter")}를 누릅니다. 예: <code>root@10.0.0.5</code>, <code>admin@192.168.0.1:2222</code></li>
        <li>시리얼은 <code>COM3</code> 또는 <code>COM3:115200</code>처럼 입력합니다.</li>
      </ol>
      <h4>세션으로 저장해 두기</h4>
      <p>왼쪽 세션 목록의 ${icon("Plus", 13)} 버튼(${kbd("Ctrl+Shift+N")})으로 접속 정보를 저장하면, 더블클릭이나 ${kbd("Enter")}로 접속합니다. 다른 프로그램에 저장해 둔 접속 정보는 <a data-goto="import">가져오기</a>로 한 번에 옮길 수 있습니다.</p>
      <h4>화면 언어</h4>
      <p>설정 맨 위의 <b>화면 언어</b>에서 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français, Deutsch 중 하나를 고릅니다(연결을 끊지 않고 바로 바뀌며, 도움말과 업데이트 안내도 그 언어로 나옵니다). 고르기 전에는 Windows 표시 언어를 따르고, 한 번 고르면 그 선택이 항상 우선합니다.</p>`,
  },
  {
    id: "sessions",
    title: "세션 목록",
    icon: "Server",
    body: `
      <ul>
        <li><b>폴더</b>: 세션 편집에서 폴더를 <code>운영/웹서버</code>처럼 슬래시로 적으면 하위 폴더가 됩니다. 세션을 폴더로 끌어 놓아도 옮겨집니다.</li>
        <li><b>정렬과 순서</b>: 세션 목록 위의 정렬 버튼에서 이름순(AP2가 AP10보다 먼저), 주소순(IP를 숫자로 비교), 최근 연결순, 사용자 지정을 고릅니다. 세션을 다른 세션의 위나 아래로 끌어 놓으면 그 자리로 옮겨지고, 폴더도 같은 방법으로 순서를 바꾸거나 다른 폴더 안으로 넣을 수 있습니다. 이렇게 순서를 바꾸면 정렬이 사용자 지정으로 바뀌고 그 순서가 유지됩니다. ${kbd("Alt+Up")} / ${kbd("Alt+Down")}으로 선택한 세션을 한 칸씩 옮기고, 폴더 메뉴의 "이 폴더 안을 이름순/주소순으로 정렬"로 한 번에 정리할 수도 있습니다.</li>
        <li><b>검색</b>: 위쪽 검색 칸에 이름·호스트·사용자·메모 일부를 입력합니다.</li>
        <li><b>여러 개 선택</b>: ${kbd("Ctrl")}+클릭으로 하나씩, ${kbd("Shift")}+클릭으로 범위를 고릅니다. ${kbd("Shift+↑/↓")}, ${kbd("Ctrl+A")}도 됩니다. ${kbd("Esc")}로 선택을 풉니다.</li>
        <li><b>여러 개 한꺼번에</b>: 선택한 상태에서 오른쪽 클릭 → 한꺼번에 수정(${kbd("F2")}: 사용자·포트·자격 증명·폴더·키 입력 방식), 폴더로 이동, 삭제(${kbd("Del")}), 모두 연결(${kbd("Enter")}).</li>
        <li><b>복사·붙여넣기</b>: 세션을 고르고 ${kbd("Ctrl+C")}, 원하는 폴더의 세션을 고르고 ${kbd("Ctrl+V")}. 붙여넣을 때마다 "이름 (2)", "이름 (3)"으로 새 세션이 생깁니다. 오른쪽 클릭 → 복제도 같습니다.</li>
        <li><b>편집</b>: ${kbd("F2")} 또는 오른쪽 클릭 → 편집.</li>
      </ul>`,
  },
  {
    id: "import",
    title: "다른 프로그램에서 가져오기",
    icon: "Download",
    body: `
      <p>세션 목록 위의 ${icon("Download", 13)} 버튼에서 고릅니다. 가져오기 전에 목록을 보여 주며, 이미 있는 세션은 건너뜁니다. <b>비밀번호는 가져오지 않습니다</b>(각 프로그램이 자체 키로 암호화해 두기 때문입니다). 처음 접속할 때 입력하거나 자격 증명 보관함에서 지정하세요.</p>
      <table class="help-table">
        <tr><th>프로그램</th><th>고를 것</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (포터블은 실행 파일 옆)</td></tr>
        <tr><td>SecureCRT</td><td>세션 폴더 <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (폴더 구조와 로그 파일 이름·자동 기록 설정까지), 또는 파일 → 설정 내보내기로 만든 XML</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (전체 파일 암호화를 쓰고 있으면 끄고 저장한 뒤)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>이 PC의 설정을 바로 읽습니다</td></tr>
        <tr><td>WinSCP</td><td>이 PC의 설정, 없으면 <code>WinSCP.ini</code></td></tr>
        <tr><td>Xshell</td><td><code>문서\\NetSarang Computer\\&lt;버전&gt;\\Xshell\\Sessions</code> 폴더</td></tr>
        <tr><td>RDCMan</td><td><code>.rdg</code> 파일</td></tr>
        <tr><td>원격 데스크톱</td><td><code>.rdp</code> 파일이 있는 폴더 (하위 폴더 포함)</td></tr>
        <tr><td>CSV</td><td>첫 줄에 열 이름: Name, Protocol, Host, Port, Username, Folder (쉼표·세미콜론·탭 구분)</td></tr>
      </table>
      <p>BananaConn끼리는 같은 메뉴의 <b>세션 백업 내보내기/가져오기(JSON)</b>를 씁니다. 백업에는 세션과 함께 빈 폴더, 스니펫·매크로, SSH 터널이 들어갑니다. 같은 PC에서 복원하면 자격 증명 연결도 그대로 살아나고, 세션이 모두 이미 있어도 없는 폴더·스니펫·터널만 복원할 수 있습니다. SSH 터널과 보안 관련 옵션(인증서 오류 무시, 포트 포워딩, 로그 파일 위치 등)은 "보안 관련 옵션도 가져오기"를 켰을 때만 가져옵니다.</p>`,
  },
  {
    id: "tabs",
    title: "탭과 화면 분할",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>탭 닫기</b>: ${kbd("Ctrl+F4")} 또는 ${kbd("Ctrl+Shift+W")}, 탭 가운데 버튼 클릭. 닫기 확인 창에서 ${kbd("Enter")}로 닫고, "다시 묻지 않기"를 체크하면 다음부터 묻지 않습니다(설정에서 다시 켤 수 있음).</li>
        <li><b>같은 세션 하나 더 열기</b>: 탭을 <b>더블클릭</b>합니다. 모니터링용으로 같은 장비에 한 번 더 붙을 때 편합니다.</li>
        <li><b>탭 이동</b>: ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. 탭이 많으면 탭 줄에서 마우스 휠로 좌우로 넘깁니다. 탭을 끌어 순서를 바꿉니다.</li>
        <li><b>화면 분할</b>: 상단의 한 화면 / 좌우 / 상하 / 4분할 버튼. 탭을 원하는 칸으로 끌어 놓습니다.</li>
        <li>탭의 점 색은 프로토콜, 깜박임은 연결 중, 빨강은 오류를 뜻합니다.</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "터미널 (SSH · Telnet · 시리얼)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>복사·붙여넣기</b>: 드래그로 선택하면 바로 복사되고, 오른쪽 클릭으로 붙여넣습니다(설정에서 바꿀 수 있음). ${kbd("Ctrl+C")}는 선택 영역이 있을 때만 복사, 없으면 장비로 전달됩니다.</li>
        <li><b>글자 크기</b>: ${kbd("Ctrl")}+마우스 휠, 또는 툴바의 ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)}.</li>
        <li><b>찾기</b>: ${kbd("Ctrl+Shift+F")}.</li>
        <li><b>키 입력 방식</b>: Cisco IOS 같은 장비에서 Delete·Home·End가 <code>~</code>로 찍히면 툴바의 "키: 장비"로 바꿉니다(Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). 세션 편집에서 기본값을 정해 둘 수 있습니다.</li>
        <li><b>시리얼</b>: 세션 편집에서 COM 포트("포트 찾기")와 속도·패리티·흐름 제어를 정합니다. 툴바의 Break로 Break 신호를 보냅니다. 여러 줄을 붙여 넣거나 툴바의 텍스트 파일 보내기로 설정 파일을 보내면, 장비가 한 줄을 받아 프롬프트를 다시 띄울 때마다 다음 줄을 보냅니다. 그래서 빠른 장비에는 빠르게 보내고 느린 장비에서도 글자가 빠지지 않습니다. 보내는 동안 진행률이 표시되며, ${kbd("Ctrl+C")}나 Break, 진행 표시의 중지를 누르면 남은 줄을 보내지 않습니다. 입력을 되돌려 보내지 않는 장비는 설정 → 터미널에서 정해진 지연으로 바꿀 수 있습니다. 콘솔 서버를 거치는 텔넷 세션은 세션 편집에서 "콘솔 서버 연결"을 켜면 같은 방식으로 보냅니다. USB 시리얼 어댑터가 빠지면 탭이 포트를 기다렸다가, 다시 꽂히면 자동으로 연결합니다. 포트 입출력은 키 입력이 읽기 대기에 막히지 않는 빠른 방식을 쓰며, 드라이버에 문제가 있으면 설정 → 터미널에서 호환 모드로 바꿀 수 있습니다.</li>
        <li><b>출력 키워드 강조</b>: ERROR·FAIL 빨강, WARN 노랑, OK·SUCCESS 초록.</li>
        <li><b>화면 그리기</b>(설정 → 터미널): "자동"은 그래픽 카드가 있는 PC에서 GPU(WebGL)로 그려 대량 출력이 빨라지고, 그래픽 카드가 없는 서버·원격 환경에서는 기본 방식으로 그립니다. 화면에 보이는 터미널만 GPU를 씁니다.</li>
        <li><b>스니펫·매크로</b>: 툴바의 스니펫에 자주 쓰는 명령을 저장해 두고, "기록"으로 입력을 녹화해 다시 재생합니다.</li>
        <li><b>파일</b>(SSH): 툴바의 파일 버튼으로 같은 서버의 SFTP 창을 옆에 엽니다.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "동시 입력",
    icon: "Radio",
    body: `
      <p>상단의 <b>동시 입력</b>을 켜면 지금 쓰는 터미널에 친 키가 <b>연결된 모든 터미널 탭</b>(화면에 안 보이는 탭 포함)에 똑같이 들어갑니다. 받는 탭은 탭의 점이 깜박입니다. 여러 장비에 같은 명령을 넣을 때 쓰고, 끝나면 꼭 끄세요. 각 탭은 자기 키 입력 방식(표준/장비)에 맞춰 Delete·Home·End를 보냅니다.</p>`,
  },
  {
    id: "log",
    title: "로그 기록",
    icon: "ScrollText",
    body: `
      <p>툴바의 <b>로그</b> 버튼으로 시작·중지합니다. 시작할 때 파일 이름을 확인·수정할 수 있고(설정에서 끌 수 있음), 상태 표시줄의 "로그 기록 중"을 누르면 파일이 있는 폴더가 열립니다.</p>
      <h4>파일 이름 치환 문자 (SecureCRT와 같음)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> 세션 이름</td><td><code>%H</code> 호스트</td><td><code>%U</code> 사용자</td><td><code>%P</code> 포트</td></tr>
        <tr><td><code>%Y</code> 연(4자리)</td><td><code>%M</code> 월</td><td><code>%D</code> 일</td><td><code>%%</code> % 기호</td></tr>
        <tr><td><code>%h</code> 시</td><td><code>%m</code> 분</td><td><code>%s</code> 초</td><td><code>%t</code> 밀리초</td></tr>
      </table>
      <p>예: <code>D:\\점검\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\점검\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>. 폴더가 없으면 만듭니다. 상대 경로는 문서\\BananaConn\\logs 아래입니다.</p>
      <ul>
        <li><b>파일이 이미 있으면</b>: 이어 쓰기 / 덮어쓰기 / 새 파일(-2, -3 …).</li>
        <li><b>각 줄 앞에</b>: 예 <code>[%h:%m:%s] </code>로 줄마다 시간을 남깁니다.</li>
        <li><b>기록을 시작할 때 / 끝낼 때</b>: 파일에 남길 문구(치환 문자 사용 가능).</li>
        <li><b>자정이 지나면 새 파일</b>: 이름에 <code>%D</code>가 있으면 날짜가 바뀔 때 새 파일로 이어 갑니다.</li>
        <li><b>연결하면 자동 기록</b>: 모든 세션(설정 → 로그) 또는 세션별(세션 편집 → 로그 → 이 세션 전용).</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "스니펫 · 매크로",
    icon: "Circle",
    body: `
      <p>자주 쓰는 명령을 저장해 두고(스니펫), 터미널에 친 키를 녹화해 그대로 다시 보냅니다(매크로).</p>
      <p><b>OS별 기본 스니펫</b>: Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS·NX-OS·ASA, FortiGate, Aruba, Juniper, Huawei에서 자주 쓰는 확인용 명령(설정을 바꾸지 않는 명령)이 들어 있습니다. 스니펫 목록에는 내 스니펫과, 그 탭에서 인식한 장비의 OS 스니펫이 먼저 나오고, 다른 OS는 "○○ 스니펫"을 누르면 나옵니다. 스니펫 관리에서 고치거나 지울 수 있고, OS 분류도 바꿀 수 있습니다.</p>
      <p><b>위험 명령</b>: 스니펫·매크로가 보내는 줄마다 설정 → 위험 명령의 규칙으로 검사합니다. 시간·NTP를 바꾸는 명령(<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> 등)은 <b>차단</b>되어 보내지 않고, 재부팅·삭제·포맷·장비 설정 변경 같은 명령은 <b>경고</b> 창에서 확인해야 보냅니다. 보내면 그 탭의 로그가 켜지고, 시도·취소·차단이 모두 로그 폴더의 <code>risky-commands.log</code>에 남습니다. <code>;</code>·<code>&amp;&amp;</code>로 이어 쓴 명령, <code>sudo</code>·<code>su -c</code>·<code>bash -c</code>·<code>eval</code> 안의 명령, 줄 끝 <code>\\</code>로 이어진 명령도 검사합니다. Tab 자동 완성이나 커서 이동 키(←→, Home, 명령 기록 ↑↓)가 든 매크로는 실제로 보낼 명령을 알 수 없어 경고합니다. 직접 입력한 명령은 Enter를 누를 때 화면에 보이는 명령 줄을 같은 규칙으로 검사합니다(명령 기록 ↑↓·Tab 자동 완성 결과 포함). vi·less처럼 화면 전체를 쓰는 프로그램 안에서는 검사하지 않고, 설정 → 위험 명령에서 끌 수 있습니다.</p>
      <p><b>입력 중인 명령의 색과 자동 완성</b>: 프롬프트 뒤에 입력 중인 명령을 명령어·옵션·문자열·경로·연결 기호별로 색을 나눠 보여 주고, 위험 명령 규칙에 걸리면 Enter 전에 빨간색으로 바꿉니다. 전에 실행한 명령(이 PC에만 저장)과 스니펫에서 나머지를 회색으로 제안하며, <kbd>→</kbd> 또는 <kbd>End</kbd>로 모두, <kbd>Ctrl</kbd>+<kbd>→</kbd>로 한 단어씩 입력합니다. <kbd>Tab</kbd>은 서버의 자동 완성 그대로입니다. <kbd>Ctrl</kbd>+<kbd>Space</kbd>는 후보 목록을 엽니다(↑↓로 고르고 Enter·Tab으로 입력, Esc로 닫기). 후보는 실행 기록, 스니펫, 인식한 장비의 명령 사전(Linux, AIX, HP-UX, Solaris, Windows, Cisco, FortiGate, Aruba, Juniper, Huawei), 리소스 모니터가 켜진 Unix 서버라면 그 서버의 PATH에 있는 명령 이름 순서로 찾습니다. 서버의 명령 이름은 모니터 연결로 한 번만 읽고, 터미널에는 아무것도 입력하지 않습니다. 명령 줄은 화면에서 읽으므로 화면에 보이지 않는 비밀번호는 기록되지 않고, 위험 명령과 비밀번호·토큰이 든 명령(<code>mysql -p…</code>, <code>--password=…</code>, <code>TOKEN=…</code>)은 기록하지도 제안하지도 않습니다. 잘못 입력한 기록은 후보 목록에서 <kbd>Shift</kbd>+<kbd>Delete</kbd>로 지웁니다. 설정 → 터미널에서 각각 끄고, 명령 기록을 지울 수 있습니다.</p>
      <h4>스니펫 만들기·보내기</h4>
      <ol>
        <li>터미널 툴바의 <b>스니펫</b> → <b>스니펫 관리…</b> → <b>새 스니펫</b>.</li>
        <li>이름과 보낼 내용을 적습니다. 여러 줄이면 한 줄씩 Enter로 들어갑니다(예: <code>terminal length 0</code> 다음 줄에 <code>show running-config</code>).</li>
        <li><b>보낸 뒤 Enter로 실행</b>을 켜면 마지막 줄도 바로 실행되고, 끄면 명령만 입력해 두고 기다립니다.</li>
        <li>보낼 때는 툴바의 <b>스니펫</b>을 눌러 목록에서 고릅니다.</li>
      </ol>
      <h4>매크로 기록·재생</h4>
      <ol>
        <li>터미널 툴바의 <b>기록</b>을 누르면 버튼이 <b>기록 끝</b>으로 바뀌고, 그때부터 친 키가 그대로 저장됩니다(Enter, Tab, Ctrl 키, 방향키, 한글 포함).</li>
        <li>장비에서 평소처럼 명령을 입력합니다. 스니펫을 보내도 매크로에 함께 기록됩니다.</li>
        <li><b>기록 끝</b>을 누르고 이름을 정하면 저장됩니다.</li>
        <li>다시 보낼 때는 툴바의 <b>스니펫</b> 목록에서 <b>매크로</b>라고 표시된 항목을 고릅니다. 기록한 키가 순서대로 그대로 들어갑니다.</li>
      </ol>
      <ul>
        <li><b>여러 장비에 한 번에</b>: 상단의 <b>동시 입력</b>을 켠 상태에서 스니펫·매크로를 보내면 연결된 모든 터미널 탭에 같이 들어갑니다.</li>
        <li><b>비밀번호는 기록하지 마세요</b>: 매크로는 친 키를 그대로 저장하므로, 기록 중에 입력한 비밀번호도 저장됩니다.</li>
        <li>매크로 내용은 <b>스니펫 관리…</b>에서 확인할 수 있습니다(⏎ = Enter, ⇥ = Tab, ^C = Ctrl+C). 이름 변경과 삭제는 되지만 키 내용은 바꿀 수 없으니, 고치려면 다시 기록하세요.</li>
        <li>스니펫과 매크로는 이 PC에 저장되며, 모든 세션에서 같이 씁니다.</li>
      </ul>`,
  },
  {
    id: "ai",
    title: "AI (명령 만들기 · 설명 · 대화 · 분석)",
    icon: "Sparkles",
    body: `
      <p>클라우드 AI(API 키), 구독 CLI, 이 PC의 로컬 LLM을 연결해 터미널 작업을 돕게 합니다. 설정 → AI에서 서비스를 추가하고 기본으로 쓸 AI를 고릅니다.</p>
      <ul>
        <li><b>연결 방식</b>: API 키(Anthropic Claude, OpenAI, Google Gemini, OpenAI 호환 서버), 구독 CLI(Claude Code, Codex CLI, Gemini CLI: PC에 설치하고 한 번 로그인해 두면 그 구독으로 답합니다), 로컬 LLM(Ollama, LM Studio·llama.cpp·vLLM 같은 OpenAI 호환 서버). API 키는 자격 증명 보관함에 저장되고, "목록 불러오기"로 모델을 고르고 "연결 확인"으로 시험합니다.</li>
        <li><b>명령 만들기</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>): 할 일을 말로 적으면, 인식한 장비·OS에 맞는 명령 하나를 만들어 줍니다. Enter를 한 번 더 누르면 입력 줄에 들어가고(실행하지 않음), 실행은 직접 Enter로 합니다. 위험 명령 규칙이 그대로 적용되어, 차단 대상(시간·NTP 변경 등)은 입력 줄에 넣지도 않습니다.</li>
        <li><b>출력 설명</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>): 선택한 텍스트(없으면 화면의 최근 출력)의 의미와 원인, 다음 단계를 설명합니다.</li>
        <li><b>AI 대화</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>): 터미널 오른쪽에 대화 창을 엽니다. "선택 영역 첨부"로 출력을 함께 보내고, 답의 명령 줄마다 있는 버튼으로 입력 줄에 넣습니다.</li>
        <li><b>AI가 직접 명령 실행</b>: AI 대화에서 할 일을 적으면 AI가 이 터미널에서 명령을 하나씩 실행해 결과를 읽고 분석합니다. 실행은 화면에 그대로 보이고 모두 <code>risky-commands.log</code>에 남습니다. 읽기 전용 명령(<code>df</code>, <code>free</code>, <code>systemctl status</code>, <code>show …</code>, <code>display …</code> 등)은 바로 실행하고, 시스템을 바꿀 수 있는 명령은 실행·건너뛰기 버튼으로 묻습니다. 차단 규칙(시간·NTP 변경 등)에 걸리는 명령은 실행하지 않습니다. 한 번에 최대 8개까지, 명령마다 30초가 지나면 Ctrl+C로 멈춥니다. 대화 창 아래 버튼에서 "모든 명령 확인"이나 "실행 안 함"으로 바꿀 수 있습니다.</li>
        <li><b>설정·로그 분석</b>: 대화 창의 파일 버튼으로 설정이나 로그 파일을 골라 점검(보안 문제, 위험한 설정)이나 분석(오류, 이상 징후)을 받습니다. 네트워크 장비는 장비 버튼 → "설정을 AI로 점검"으로 running-config를 바로 점검합니다.</li>
        <li><b>보내는 내용</b>: 클라우드 AI로 보내기 전에 보낼 내용을 보여 주고 확인을 받습니다(대화마다 "다시 묻지 않기" 가능). 비밀번호·키·토큰(<code>password=…</code>, <code>-p…</code>, <code>enable secret</code>, <code>snmp-server community</code>, 개인 키 등)은 항상 가리고, 설정에서 켜면 IP 주소·호스트 이름도 IP_1, HOST_1처럼 바꿔 보낸 뒤 답에서는 원래 값으로 보여 줍니다. 로컬 LLM은 이 PC 밖으로 나가지 않으므로 묻거나 가리지 않습니다. 회사 장비의 정보를 외부 AI에 보내도 되는지는 회사 보안 정책을 확인하세요.</li>
        <li>구독 CLI는 Claude Code를 도구를 모두 끈 채(명령 실행·파일 읽기 없음) 빈 폴더에서, Codex를 읽기 전용 샌드박스로 실행합니다. 로그인 정보는 앱이 다루지 않습니다.</li>
        <li><b>첨부·원격 데스크톱</b>: 대화 창의 📎 버튼, 끌어다 놓기, <kbd>Ctrl</kbd>+<kbd>V</kbd>(스크린샷)로 이미지·PDF·텍스트 파일을 첨부합니다. 텍스트 파일은 메시지에 들어가 가림이 적용되고, 이미지·PDF는 가릴 수 없어 미리보기에 그대로 보여 줍니다. 큰 이미지는 자동으로 줄입니다. 이미지는 대부분의 서비스가, PDF는 Claude·Gemini·OpenAI API와 Claude Code가 받습니다. RDP·VNC 툴바의 "AI"에서는 원격 화면을 캡처해 설명을 받거나 대화에 첨부할 수 있습니다. 원격 데스크톱에서는 AI가 명령을 실행하지 않고, 답의 명령은 복사 버튼으로 복사해 원격 화면에 붙여넣습니다.</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "장비 자동 인식 · CPU · 메모리",
    icon: "Activity",
    body: `
      <p>SSH·Telnet으로 접속하면 별도의 모니터링 연결이 장비 종류를 자동으로 알아내고, 상태 표시줄에 장비 이름과 CPU·메모리(서버는 디스크까지)를 표시합니다. 터미널 화면에는 아무것도 입력하지 않습니다.</p>
      <p>인식하는 장비: <b>Cisco</b> IOS · IOS-XE · NX-OS · ASA, <b>Fortinet</b> FortiGate, <b>Aruba</b> AOS-CX · AOS-Switch(ProCurve) · 무선 컨트롤러, <b>Juniper</b> Junos, <b>Huawei</b> VRP, 서버는 <b>Red Hat 등 리눅스</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b>.</p>
      <ul>
        <li><b>장비 버튼</b>: 인식이 끝나면 터미널 툴바에 장비 이름 버튼이 생깁니다. 누르면 그 장비에서 자주 쓰는 조회 명령(인터페이스, 라우팅, VLAN, HA, 오류 로그 등)을 한 번에 입력할 수 있습니다. 설정을 바꾸는 명령은 넣지 않았습니다.</li>
        <li><b>설정 백업</b>: 네트워크 장비는 장비 버튼 → "설정 백업"으로 running-config(FortiGate는 <code>show</code>)를 <code>장비이름_날짜시각.cfg</code> 파일로 저장합니다. 모니터링 연결로 읽으므로 작업 중인 터미널을 방해하지 않습니다. 권한이 없어 장비가 거부하거나 설정의 끝(IOS의 <code>end</code>, Huawei의 <code>return</code> 등)을 받지 못하면 저장하지 않습니다.</li>
        <li><b>키 방식 자동 전환</b>: 네트워크 장비로 인식되면, 아직 키 방식을 고르지 않은 세션은 장비 방식(Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E)으로 바뀝니다.</li>
        <li><b>상위 프로세스</b>: 상태 표시줄의 CPU·메모리를 누르면 CPU·메모리 사용량 상위 10개 프로세스와 디스크 목록(리눅스)을 봅니다.</li>
        <li>모니터링은 별도 로그인을 하나 더 씁니다. <b>같은 장비에 탭을 여러 개 열어도 모니터링 연결은 하나만</b> 씁니다(장비의 VTY 수를 아끼기 위해).</li>
        <li>읽는 주기는 리눅스 2초(Telnet으로 접속하면 10초), 네트워크 장비 15초, AIX·HP-UX·Solaris 10초입니다. 서버의 셸 기록(<code>~/.sh_history</code> 등)에는 모니터링 명령이 남지 않습니다. 그 장비의 탭이 화면에 없거나 창을 최소화하면 멈추고(장비는 로그인이 끊기지 않게 5분에 한 번만 확인), 다시 보이면 바로 읽습니다.</li>
        <li>"클릭해 로그인"이 보이면 눌러서 모니터링용 비밀번호를 입력합니다(저장하지 않음). 비밀번호를 모르면 모니터링 연결은 사용자 이름을 보내기 전에 끊어, 장비에 실패한 로그인이 남지 않습니다. 비밀번호 없이 들어가는 Telnet 장비라면 비밀번호를 비워 두고 시작합니다. 로그인 뒤 장비가 일회용 코드처럼 무언가를 물으면 모니터링을 하지 않습니다. 끄려면 설정 → 세션.</li>
      </ul>`,
  },
  {
    id: "files",
    title: "파일 전송 (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>왼쪽은 내 PC, 오른쪽은 서버입니다. 항목을 반대쪽으로 끌어 놓거나 전송 버튼을 누릅니다. 폴더는 하위 항목까지 보냅니다.</li>
        <li>같은 이름이 있으면 덮어쓸지 묻습니다. 전송 중에는 진행률과 취소가 있습니다.</li>
        <li><b>TFTP</b>: 세션 종류(또는 빠른 연결)에서 TFTP를 고르면 TFTP 탭이 열립니다. TFTP는 로그인과 폴더 목록이 없어서, <b>서버의 파일 이름</b>을 적고 "받기"를 누르거나, 내 PC의 파일을 골라 "보내기"를 누릅니다. 블록 크기는 "자동"이 대부분의 장비에 맞고, 옵션을 모르는 오래된 서버는 자동으로 512로 주고받습니다. 장비가 내 PC로 파일을 보내게 하려면(예: <code>copy running-config tftp:</code>) 상단 "서버" 버튼의 <b>TFTP 서버</b>를 켜세요.</li>
        <li>SFTP로 폴더를 보내면 파일 4개를 동시에 전송합니다. 작은 파일이 많은 폴더는 원격지가 멀수록 훨씬 빨라집니다. FTP는 서버 연결 수 제한 때문에 한 번에 하나씩 보내지만, 전송 중에도 폴더를 탐색할 수 있습니다.</li>
        <li>서버의 텍스트 파일을 더블클릭하면 내장 편집기로 열고, 저장하면 서버에 바로 반영합니다.</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "원격 데스크톱 (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>화면 크기</b>: 세션의 해상도가 "자동"이면 탭 크기에 맞춥니다. 창 크기를 바꾸면 원격 해상도도 따라가고, 서버가 실시간 변경을 지원하지 않으면 새 크기로 자동 재연결합니다.</li>
        <li><b>맞춤</b>: 원격 화면을 탭에 맞춰 늘리거나 줄여 보여 줄지(켜짐), 실제 크기로 볼지(꺼짐) 고릅니다.</li>
        <li><b>복사·붙여넣기</b>: mstsc처럼 내 PC와 원격 PC 사이에서 텍스트·이미지·<b>파일과 폴더</b>를 ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}로 주고받습니다(세션 옵션 "클립보드 공유"). 원격에서 복사한 파일은 붙여넣을 때 받아 오며, 툴바에 받는 진행률이 표시됩니다.</li>
        <li>키보드: 내 PC의 키보드 종류와 레이아웃(한국어 103/106키 등)을 원격에 그대로 알려서 오른쪽 Shift·Ctrl·Alt, 한/영·한자 키가 mstsc와 같게 동작합니다. Num Lock·Caps Lock 상태도 서버에 맞추므로, 로그인 화면에서 Num Lock을 다시 누르지 않아도 숫자 키패드가 바로 입력됩니다.</li>
        <li>툴바: ${kbd("Ctrl+Alt+Del")} 보내기, Windows 키, 클립보드 내용을 키 입력으로 보내기, mstsc로 열기.</li>
        <li>처음 접속할 때 서버 인증서 지문을 확인하고, 신뢰하면 다음부터 묻지 않습니다.</li>
        <li>다른 탭을 보고 있거나 창을 최소화하면 그 RDP 탭은 화면을 그리지 않고, 다시 보면 전체 화면을 한 번에 받아 옵니다.</li>
        <li><b>VNC 속도</b>: 툴바의 "화질"에서 빠르게(기본: 색·화질을 낮추고 최대한 압축)·보통·선명하게를 고릅니다(연결을 끊지 않고 바로 적용). "상태"를 켜면 서버가 쓰는 인코딩과 초당 받는 양이 보입니다. Raw·Hextile만 보이면 서버가 압축을 쓰지 않는 것입니다.</li>
        <li>VNC가 느릴 때는 대개 <b>서버 설정</b>이 원인입니다. TightVNC 서버라면: 서버 설정 → Server 탭의 <b>화면 폴링 주기(Screen polling cycle)</b>를 1000ms에서 30~50ms로 줄이고, <b>투명 창 캡처(Grab transparent windows)</b>를 끄고, <b>미러 드라이버(DFMirage)</b>가 있으면 사용하게 하세요. 바탕 화면 배경 제거도 효과가 큽니다. 4K처럼 큰 화면에서는 TightVNC가 화면 변화를 따라가지 못해 수십 초씩 늦어질 수 있습니다(같은 PC에서 측정: TightVNC 34~46초 지연, UltraVNC 거의 실시간). 이럴 때는 <b>UltraVNC 서버</b>를 쓰고, 설정의 Capture 탭에서 Windows 화면 복제(DDengine)를 켜 두세요.</li>
        <li>내장 RDP는 mstsc의 그래픽 가속(H.264)을 쓰지 않으므로 화면이 많이 움직이면 mstsc보다 느릴 수 있습니다. 이럴 때는 "mstsc로 열기"를 쓰세요.</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "도구 · 파일 서버",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>SSH 게이트웨이</b>: RDP·VNC·Telnet 세션 편집에서 저장된 SSH 세션을 게이트웨이로 고르면 그 서버를 거쳐 방화벽 안쪽 장비에 접속합니다.</li>
        <li><b>프록시</b>: 세션 편집의 "프록시"에서 PuTTY의 Connection → Proxy처럼 SOCKS 4/4a, SOCKS 5, HTTP CONNECT, Telnet(명령으로 연결), 로컬 명령을 고릅니다. SSH, SFTP, Telnet, FTP/FTPS, RDP, VNC와 그 세션의 리소스 모니터가 모두 프록시를 거칩니다. 프록시 로그인은 자격 증명 보관함에서 고르고, 프록시를 거치지 않을 호스트(*.corp.local, 10.0.0.0/8), DNS 조회 위치, 진단 메시지 표시를 정할 수 있습니다. FTP는 프록시를 거칠 때 수동(PASV) 모드로 연결합니다. PuTTY·KiTTY에서 세션을 가져오면 프록시 설정도 함께 가져옵니다(비밀번호는 제외).</li>
        <li><b>SSH 터널</b>: 상단 도구 → SSH 터널. 내 PC 포트 → SSH 서버 → 대상 주소 포워딩을 저장해 두고 켜고 끕니다.</li>
        <li><b>네트워크 도구</b>: ping, TCP 포트 확인(여러 포트·범위), DNS 조회.</li>
        <li><b>파일 서버</b>: 상단 파일 서버 버튼으로 이 PC의 폴더를 FTP·TFTP·HTTP로 잠깐 공유합니다(장비 OS 업로드 등).</li>
      </ul>`,
  },
  {
    id: "security",
    title: "자격 증명 · 보안",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>자격 증명 보관함</b>(상단 열쇠 버튼): 비밀번호와 SSH 키를 Windows 자격 증명 관리자에 저장하고, 세션 편집에서 골라 씁니다. 저장된 비밀번호는 화면으로 보내지 않습니다.</li>
        <li><b>마스터 비밀번호</b>(설정 → 보안): 시작할 때와 자리를 비운 뒤 앱을 잠급니다.</li>
        <li>SSH·SFTP 호스트 키는 <code>~/.ssh/known_hosts</code>로 확인하며, 처음 보는 키는 지문을 보여 주고 확인을 받습니다. 바뀐 키는 연결을 막습니다.</li>
      </ul>`,
  },
  {
    id: "update",
    title: "업데이트",
    icon: "RefreshCw",
    body: `
      <p>앱을 시작할 때와 실행 중 <b>30분마다</b>(자리를 비웠다가 창으로 돌아왔을 때도) <b>GitHub</b>(github.com/NijG/bananaconn)에서 새 버전을 확인합니다. 보안 정책으로 GitHub에 접속할 수 없는 PC는 설정 → 업데이트에 <b>NAS 업데이트 폴더</b>(새 버전을 올려 두는 공유 폴더)를 지정하세요. GitHub에 접속할 수 없을 때 그 폴더에서 확인합니다. 새 버전을 찾으면 <b>지금 업데이트할지 묻는 창</b>이 뜹니다. "지금 업데이트"를 누르면 앱이 닫혔다가 설치 후 다시 열립니다(열린 연결은 끊어집니다). "나중에"를 누르면 상태 표시줄 오른쪽의 <b>업데이트</b> 버튼으로 언제든 설치할 수 있습니다. 묻는 창은 처음에 "나중에"가 선택되어 있어서, 터미널에 입력하던 Enter로 업데이트가 시작되지 않습니다.</p>
      <p><b>"암호가 맞지 않습니다"로 접속이 안 될 때</b>: Windows는 공유 폴더에 지금 로그인한 Windows 계정으로 접속하고, 공유 폴더가 익명(게스트) 읽기를 허용해도 게스트로 넘어가지 않습니다. 탐색기에서 업데이트 폴더를 열어 NAS 계정을 입력하고 "자격 증명 기억"을 체크하거나, 설정 → 업데이트의 <b>NAS 계정</b>에서 자격 증명 보관함의 계정을 고르세요. 앱이 그 계정으로 로그인합니다.</p>
      <p>빌드한 PC의 서명이 맞는 파일만 설치하므로, 공유 폴더에 다른 사람이 넣은 파일은 설치하지 않습니다. "지금 확인"으로 바로 확인할 수도 있습니다.</p>`,
  },
  {
    id: "keys",
    title: "단축키",
    icon: "Keyboard",
    body: `
      <p>단축키는 <b>설정 → 단축키</b>(또는 홈 화면의 "단축키 설정")에서 모두 보고 바꿀 수 있습니다. 단축키가 없는 동작(화면 나누기, n번째 탭, 로그 켜기 등)과 스니펫·매크로에도 새로 지정할 수 있고, 동작별 "기본값" 또는 "모두 기본값으로"로 되돌립니다. 아래 표는 기본값입니다.</p>
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>이 도움말 (터미널 안에서는 원격 프로그램으로 감)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>새 세션</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>빠른 연결 칸으로</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>다음 / 이전 탭</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>탭 닫기</td></tr>
        <tr><td>탭 더블클릭</td><td>같은 세션 하나 더 열기</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>터미널에서 찾기</td></tr>
        <tr><td>${kbd("Ctrl")}+휠</td><td>터미널 글자 크기</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>사이드바 접기</td></tr>
        <tr><td colspan="2"><b>세션 목록에서</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>연결 / 편집 / 삭제 (여러 개 선택 시 한꺼번에)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>세션 복사 / 붙여넣기</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+클릭, ${kbd("Ctrl+A")}</td><td>여러 개 선택</td></tr>
      </table>`,
  },
];

/** The guide in other languages: help/<language>.ts, loaded when first opened. */
const TRANSLATIONS = import.meta.glob<{ SECTIONS: HelpSection[] }>("./help/*.ts");

/** The guide's sections in the screen language (English when it has none of its own). */
async function sections(): Promise<HelpSection[]> {
  const lang = language();
  if (lang === "ko") return KO_SECTIONS;
  const load = TRANSLATIONS[`./help/${lang}.ts`] ?? TRANSLATIONS["./help/en.ts"];
  return load ? (await load()).SECTIONS : KO_SECTIONS;
}

/** Open the guide, optionally at a section. */
export async function openHelp(sectionId = "start") {
  // The guide itself is written per language (the rest of the UI is translated as it appears).
  const SECTIONS = await sections();
  const m = modal({
    title: "BananaConn 사용법",
    icon: "CircleHelp",
    width: 940,
    body: `<div class="help">
        <nav class="help-nav">
          <label class="side-search">${icon("Search", 14)}<input placeholder="도움말 검색" spellcheck="false" data-help-search/></label>
          ${SECTIONS.map((s) => `<button type="button" data-help="${s.id}">${icon(s.icon, 15)}<span>${esc(s.title)}</span></button>`).join("")}
        </nav>
        <article class="help-body"></article>
      </div>`,
  });
  const body = m.root.querySelector<HTMLElement>(".help-body")!;
  const buttons = [...m.root.querySelectorAll<HTMLButtonElement>("[data-help]")];
  const show = (id: string) => {
    const s = SECTIONS.find((x) => x.id === id) ?? SECTIONS[0];
    body.innerHTML = `<h3>${icon(s.icon, 18)}${esc(s.title)}</h3>${s.body}`;
    body.scrollTop = 0;
    buttons.forEach((b) => b.classList.toggle("on", b.dataset.help === s.id));
    body.querySelectorAll<HTMLElement>("[data-goto]").forEach((a) => a.addEventListener("click", () => show(a.dataset.goto!)));
  };
  buttons.forEach((b) => b.addEventListener("click", () => show(b.dataset.help!)));
  const search = m.root.querySelector<HTMLInputElement>("[data-help-search]")!;
  // The text as the reader sees it: entities decoded ("&amp;" is "&"), runs of
  // spaces collapsed, and key combinations written "ctrl+c" either way.
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").replace(/\s*\+\s*/g, "+").trim();
  const texts = new Map<string, string>();
  const plain = (s: HelpSection) => {
    let t = texts.get(s.id);
    if (t === undefined) {
      const el = document.createElement("div");
      el.innerHTML = s.body;
      t = norm(`${s.title} ${el.textContent ?? ""}`);
      texts.set(s.id, t);
    }
    return t;
  };
  search.addEventListener("input", () => {
    const q = norm(search.value);
    let first: string | null = null;
    for (const b of buttons) {
      const hit = !q || plain(SECTIONS.find((s) => s.id === b.dataset.help)!).includes(q);
      b.hidden = !hit;
      if (hit && !first) first = b.dataset.help!;
    }
    if (first && q) show(first);
    else if (q && !first) {
      body.innerHTML = `<p class="muted">"${esc(search.value.trim())}"와 일치하는 내용이 없습니다.</p>`;
      buttons.forEach((b) => b.classList.remove("on"));
    }
  });
  show(sectionId);
}
