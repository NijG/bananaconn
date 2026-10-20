// Vietnamese version of the in-app usage guide (same sections, ids and icons as help.ts).

import type { HelpSection } from "../help";
import { icon } from "../icons";
import { esc } from "../ui";

const kbd = (k: string) => k.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+");

export const SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "Bắt đầu",
    icon: "Sparkles",
    body: `
      <p>BananaConn là công cụ truy cập từ xa gom các kết nối SSH, Telnet, nối tiếp (COM), SFTP, FTP/FTPS, RDP và VNC vào các tab.</p>
      <h4>Kết nối ngay (Kết nối nhanh)</h4>
      <ol>
        <li>Chọn giao thức (SSH, Telnet …) ở góc trên bên trái.</li>
        <li>Nhập <code>user@host:port</code> vào ô bên cạnh rồi nhấn ${kbd("Enter")}. Ví dụ: <code>root@10.0.0.5</code>, <code>admin@192.168.0.1:2222</code></li>
        <li>Với cổng nối tiếp, nhập <code>COM3</code> hoặc <code>COM3:115200</code>.</li>
      </ol>
      <h4>Lưu thành phiên</h4>
      <p>Lưu thông tin kết nối bằng nút ${icon("Plus", 13)} trong danh sách phiên (${kbd("Ctrl+Shift+N")}), sau đó kết nối bằng cách nhấp đúp hoặc nhấn ${kbd("Enter")}. Các kết nối đã lưu trong chương trình khác có thể chuyển sang một lần bằng <a data-goto="import">Nhập</a>.</p>
      <h4>Ngôn ngữ giao diện</h4>
      <p><b>Ngôn ngữ</b> ở đầu Cài đặt chuyển giao diện sang 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français hoặc Deutsch (ngay lập tức, không ngắt kết nối; hướng dẫn và ghi chú cập nhật cũng đổi theo). Cho đến khi bạn chọn, ứng dụng theo ngôn ngữ hiển thị của Windows; khi đã chọn, lựa chọn của bạn luôn được ưu tiên.</p>`,
  },
  {
    id: "sessions",
    title: "Danh sách phiên",
    icon: "Server",
    body: `
      <ul>
        <li><b>Thư mục</b>: Trong trình sửa phiên, ghi thư mục bằng dấu gạch chéo, như <code>Prod/Web servers</code>, để tạo thư mục con. Bạn cũng có thể kéo phiên thả vào thư mục để di chuyển.</li>
        <li><b>Sắp xếp và thứ tự</b>: Nút sắp xếp phía trên danh sách phiên cho phép chọn theo tên (AP2 trước AP10), theo địa chỉ (so sánh IP theo số), kết nối gần đây hoặc tùy chỉnh. Kéo một phiên lên trên hoặc xuống dưới phiên khác để đặt nó vào đó; thư mục cũng được đổi thứ tự, hoặc chuyển vào thư mục khác, theo cách tương tự. Đổi thứ tự sẽ chuyển sang thứ tự tùy chỉnh và giữ nguyên thứ tự đó. ${kbd("Alt+Up")} / ${kbd("Alt+Down")} chuyển phiên đang chọn lên hoặc xuống một vị trí, và "Sắp xếp thư mục này theo tên/địa chỉ" trong menu thư mục sắp xếp lại một lần.</li>
        <li><b>Tìm kiếm</b>: Nhập một phần tên, máy chủ, người dùng hoặc ghi chú vào ô tìm kiếm ở trên cùng.</li>
        <li><b>Chọn nhiều</b>: ${kbd("Ctrl")}+nhấp để chọn từng mục, ${kbd("Shift")}+nhấp để chọn một dải. ${kbd("Shift+↑/↓")} và ${kbd("Ctrl+A")} cũng dùng được. ${kbd("Esc")} bỏ chọn.</li>
        <li><b>Thao tác hàng loạt</b>: Khi chọn nhiều mục, nhấp chuột phải → Sửa hàng loạt (${kbd("F2")}: người dùng, cổng, thông tin đăng nhập, thư mục, chế độ phím), Di chuyển vào thư mục, Xóa (${kbd("Del")}), Kết nối tất cả (${kbd("Enter")}).</li>
        <li><b>Sao chép &amp; dán</b>: Chọn phiên và nhấn ${kbd("Ctrl+C")}, chọn một phiên trong thư mục đích và nhấn ${kbd("Ctrl+V")}. Mỗi lần dán tạo một phiên mới tên "Tên (2)", "Tên (3)". Nhấp chuột phải → Nhân bản cũng tương tự.</li>
        <li><b>Sửa</b>: ${kbd("F2")} hoặc nhấp chuột phải → Sửa.</li>
      </ul>`,
  },
  {
    id: "import",
    title: "Nhập từ chương trình khác",
    icon: "Download",
    body: `
      <p>Chọn từ nút ${icon("Download", 13)} phía trên danh sách phiên. Danh sách xem trước được hiển thị trước khi nhập, và các phiên đã có sẽ được bỏ qua. <b>Mật khẩu không được nhập</b> (mỗi chương trình mã hóa bằng khóa riêng). Hãy nhập khi kết nối lần đầu hoặc gán từ kho thông tin đăng nhập.</p>
      <table class="help-table">
        <tr><th>Chương trình</th><th>Cần chọn</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (bản portable: cạnh tệp thực thi)</td></tr>
        <tr><td>SecureCRT</td><td>Thư mục phiên <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (gồm cấu trúc thư mục, tên tệp nhật ký và cài đặt tự động ghi nhật ký), hoặc tệp XML tạo bằng File → Export Settings</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (nếu bật mã hóa toàn bộ tệp, hãy tắt và lưu trước)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>Đọc trực tiếp cài đặt trên PC này</td></tr>
        <tr><td>WinSCP</td><td>Cài đặt trên PC này, hoặc <code>WinSCP.ini</code> nếu không có</td></tr>
        <tr><td>Xshell</td><td>Thư mục <code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code></td></tr>
        <tr><td>RDCMan</td><td>Tệp <code>.rdg</code></td></tr>
        <tr><td>Remote Desktop</td><td>Thư mục chứa tệp <code>.rdp</code> (bao gồm thư mục con)</td></tr>
        <tr><td>CSV</td><td>Tên cột ở dòng đầu: Name, Protocol, Host, Port, Username, Folder (phân tách bằng dấu phẩy, dấu chấm phẩy hoặc tab)</td></tr>
      </table>
      <p>Giữa các bản cài BananaConn, dùng <b>Xuất/Nhập bản sao lưu phiên (JSON)</b> trong cùng menu. Bản sao lưu gồm các phiên cùng với thư mục trống, đoạn lệnh/macro và đường hầm SSH. Khi khôi phục trên cùng một PC, liên kết với thông tin đăng nhập vẫn được giữ nguyên, và kể cả khi mọi phiên đã có sẵn, bạn vẫn có thể chỉ khôi phục các thư mục, đoạn lệnh và đường hầm còn thiếu. Đường hầm SSH và các tùy chọn liên quan đến bảo mật (bỏ qua lỗi chứng chỉ, chuyển tiếp cổng, vị trí tệp nhật ký, v.v.) chỉ được nhập khi bật "Nhập cả các tùy chọn liên quan đến bảo mật".</p>`,
  },
  {
    id: "tabs",
    title: "Tab và chia màn hình",
    icon: "LayoutGrid",
    body: `
      <ul>
        <li><b>Đóng tab</b>: ${kbd("Ctrl+F4")} hoặc ${kbd("Ctrl+Shift+W")}, hoặc nhấp chuột giữa vào tab. Nhấn ${kbd("Enter")} trong hộp xác nhận để đóng; đánh dấu "Không hỏi lại" để bỏ qua lần sau (có thể bật lại trong Cài đặt).</li>
        <li><b>Mở lại cùng phiên</b>: <b>Nhấp đúp</b> vào tab. Tiện khi cần kết nối thứ hai tới cùng thiết bị để giám sát.</li>
        <li><b>Chuyển tab</b>: ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. Khi có nhiều tab, cuộn chuột trên thanh tab để di chuyển sang trái và phải. Kéo tab để sắp xếp lại.</li>
        <li><b>Chia màn hình</b>: Các nút một khung / trái-phải / trên-dưới / chia 4 ở trên cùng. Kéo tab vào khung bạn muốn.</li>
        <li>Màu chấm trên tab cho biết giao thức, nhấp nháy nghĩa là đang kết nối, còn màu đỏ nghĩa là có lỗi.</li>
      </ul>`,
  },
  {
    id: "terminal",
    title: "Terminal (SSH · Telnet · Nối tiếp)",
    icon: "SquareTerminal",
    body: `
      <ul>
        <li><b>Sao chép &amp; dán</b>: Kéo để chọn sẽ sao chép ngay, nhấp chuột phải để dán (có thể đổi trong Cài đặt). ${kbd("Ctrl+C")} chỉ sao chép khi có vùng chọn; nếu không, nó được gửi tới thiết bị.</li>
        <li><b>Cỡ chữ</b>: ${kbd("Ctrl")}+cuộn chuột, hoặc ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)} trên thanh công cụ.</li>
        <li><b>Tìm</b>: ${kbd("Ctrl+Shift+F")}.</li>
        <li><b>Chế độ phím</b>: Nếu Delete, Home hoặc End in ra <code>~</code> trên thiết bị như Cisco IOS, hãy chuyển thanh công cụ sang "Phím: Thiết bị" (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). Có thể đặt mặc định trong trình sửa phiên.</li>
        <li><b>Nối tiếp</b>: Trong trình sửa phiên, đặt cổng COM ("Tìm cổng"), tốc độ, chẵn lẻ và điều khiển luồng. Nút Break trên thanh công cụ gửi tín hiệu Break. Khi dán nhiều dòng hoặc gửi cấu hình bằng "Gửi tệp văn bản" trên thanh công cụ, từng dòng được gửi lần lượt: mỗi dòng đi ngay khi thiết bị đã nhận dòng trước và hiện lại dấu nhắc, nên thiết bị nhanh nhận nhanh còn thiết bị chậm không bị mất ký tự. Tiến độ được hiển thị trong khi gửi; ${kbd("Ctrl+C")}, Break hoặc "Dừng" trong ô tiến độ sẽ bỏ các dòng còn lại. Với thiết bị không phản hồi lại đầu vào, chọn độ trễ cố định trong Cài đặt → Terminal. Phiên Telnet qua console server cũng hoạt động như vậy khi bật "Kết nối console server" trong trình chỉnh sửa phiên. Khi bộ chuyển đổi USB nối tiếp bị rút, tab sẽ chờ cổng và tự kết nối lại ngay khi được cắm lại. Nhập/xuất cổng dùng chế độ nhanh, trong đó phím gõ không phải chờ thao tác đọc; nếu trình điều khiển có vấn đề, hãy chuyển sang chế độ tương thích trong Cài đặt → Terminal.</li>
        <li><b>Tô sáng từ khóa đầu ra</b>: ERROR·FAIL màu đỏ, WARN màu vàng, OK·SUCCESS màu xanh lá.</li>
        <li><b>Kết xuất</b> (Cài đặt → Terminal): "Tự động" vẽ bằng GPU (WebGL) trên PC có card đồ họa, giúp tăng tốc khi đầu ra nhiều, và dùng trình kết xuất tiêu chuẩn trên máy chủ và phiên từ xa không có card đồ họa. Chỉ các terminal đang hiển thị trên màn hình mới dùng GPU.</li>
        <li><b>Đoạn lệnh &amp; macro</b>: Lưu các lệnh hay dùng trong Đoạn lệnh trên thanh công cụ, và dùng "Ghi" để ghi lại dữ liệu nhập rồi phát lại.</li>
        <li><b>Tệp</b> (SSH): Nút Tệp trên thanh công cụ mở khung SFTP của cùng máy chủ ở bên cạnh.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "Nhập đồng thời",
    icon: "Radio",
    body: `
      <p>Bật <b>Nhập đồng thời</b> ở trên cùng, các phím gõ trong terminal hiện tại sẽ được gửi tới <b>mọi tab terminal đang kết nối</b> (kể cả tab không hiển thị trên màn hình). Tab nhận có chấm nhấp nháy. Dùng để gửi cùng một lệnh tới nhiều thiết bị, và nhớ tắt khi xong. Mỗi tab gửi Delete, Home và End theo chế độ phím riêng của nó (tiêu chuẩn/thiết bị).</p>`,
  },
  {
    id: "log",
    title: "Ghi nhật ký phiên",
    icon: "ScrollText",
    body: `
      <p>Bắt đầu và dừng bằng nút <b>Nhật ký</b> trên thanh công cụ. Khi bắt đầu, bạn có thể kiểm tra và sửa tên tệp (có thể tắt trong Cài đặt), và nhấp "Đang ghi nhật ký" trên thanh trạng thái sẽ mở thư mục chứa tệp.</p>
      <h4>Ký tự thay thế trong tên tệp (giống SecureCRT)</h4>
      <table class="help-table">
        <tr><td><code>%S</code> tên phiên</td><td><code>%H</code> máy chủ</td><td><code>%U</code> người dùng</td><td><code>%P</code> cổng</td></tr>
        <tr><td><code>%Y</code> năm (4 chữ số)</td><td><code>%M</code> tháng</td><td><code>%D</code> ngày</td><td><code>%%</code> ký tự %</td></tr>
        <tr><td><code>%h</code> giờ</td><td><code>%m</code> phút</td><td><code>%s</code> giây</td><td><code>%t</code> mili giây</td></tr>
      </table>
      <p>Ví dụ: <code>D:\\Checks\\CRT_Log\\%S (%H)_%Y%M%D.log</code> → <code>D:\\Checks\\CRT_Log\\SERVER01 (10.1.1.5)_20261015.log</code>. Thư mục chưa có sẽ được tạo. Đường dẫn tương đối nằm trong Documents\\BananaConn\\logs.</p>
      <ul>
        <li><b>Nếu tệp đã tồn tại</b>: Ghi tiếp / Ghi đè / Tệp mới (-2, -3 …).</li>
        <li><b>Tiền tố mỗi dòng</b>: VD <code>[%h:%m:%s] </code> để gắn dấu thời gian cho từng dòng.</li>
        <li><b>Khi bắt đầu / khi kết thúc</b>: Văn bản ghi vào tệp (dùng được ký tự thay thế).</li>
        <li><b>Tệp mới sau nửa đêm</b>: Nếu tên chứa <code>%D</code>, việc ghi sẽ tiếp tục sang tệp mới khi đổi ngày.</li>
        <li><b>Tự động ghi khi kết nối</b>: Cho mọi phiên (Cài đặt → Nhật ký) hoặc từng phiên (trình sửa phiên → Nhật ký → Chỉ phiên này).</li>
      </ul>`,
  },
  {
    id: "macros",
    title: "Đoạn lệnh · Macro",
    icon: "Circle",
    body: `
      <p>Lưu các lệnh hay dùng (đoạn lệnh), hoặc ghi lại các phím bạn gõ trong terminal rồi gửi lại y hệt (macro).</p>
      <p><b>Đoạn lệnh tích hợp theo OS</b>: các lệnh kiểm tra chỉ đọc thông dụng (không thay đổi gì) cho Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS · NX-OS · ASA, FortiGate, Aruba, Juniper và Huawei. Danh sách đoạn lệnh hiển thị trước tiên các đoạn lệnh của bạn và của OS được nhận diện trong tab đó; các hệ thống khác chỉ cách một cú nhấp trong "Đoạn lệnh …". Sửa, xóa hoặc đổi nhóm OS của chúng trong Quản lý đoạn lệnh.</p>
      <p><b>Lệnh nguy hiểm</b>: mọi dòng mà đoạn lệnh hoặc macro gửi đi đều được kiểm tra theo các quy tắc trong Cài đặt → Lệnh nguy hiểm. Các lệnh thay đổi thời gian hoặc NTP (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) bị <b>chặn</b> và không bao giờ được gửi; các lệnh như khởi động lại, xóa, định dạng hoặc thay đổi cấu hình thiết bị cần xác nhận trong <b>cảnh báo</b> trước. Khi gửi, nhật ký của tab đó được bật, và mọi lần thử, hủy và chặn đều được ghi vào <code>risky-commands.log</code> trong thư mục nhật ký. Các lệnh nối bằng <code>;</code> hoặc <code>&amp;&amp;</code>, lệnh bên trong <code>sudo</code>, <code>su -c</code>, <code>bash -c</code> hoặc <code>eval</code>, và các dòng nối tiếp bằng <code>\\</code> ở cuối dòng cũng được kiểm tra. Macro có tự hoàn thành bằng Tab hoặc phím di chuyển con trỏ (←→, Home, lịch sử lệnh ↑↓) sẽ bị cảnh báo, vì không thể biết lệnh thực sự được gửi. Các lệnh bạn tự gõ không bị kiểm tra.</p>
      <h4>Tạo và gửi đoạn lệnh</h4>
      <ol>
        <li>Trên thanh công cụ terminal: <b>Đoạn lệnh</b> → <b>Quản lý đoạn lệnh…</b> → <b>Đoạn lệnh mới</b>.</li>
        <li>Nhập tên và nội dung cần gửi. Nhiều dòng sẽ được gửi lần lượt từng dòng kèm Enter (VD <code>terminal length 0</code> rồi <code>show running-config</code> ở dòng tiếp theo).</li>
        <li>Khi bật <b>Nhấn Enter sau khi gửi</b>, dòng cuối được chạy ngay; khi tắt, lệnh chỉ được gõ vào và chờ.</li>
        <li>Để gửi, nhấp <b>Đoạn lệnh</b> trên thanh công cụ và chọn từ danh sách.</li>
      </ol>
      <h4>Ghi và phát macro</h4>
      <ol>
        <li>Nhấp <b>Ghi</b> trên thanh công cụ terminal; nút chuyển thành <b>Dừng ghi</b> và mọi phím bạn gõ từ lúc đó được lưu nguyên vẹn (kể cả Enter, Tab, phím Ctrl, phím mũi tên và nhập từ IME).</li>
        <li>Gõ lệnh trên thiết bị như bình thường. Các đoạn lệnh bạn gửi cũng được ghi vào macro.</li>
        <li>Nhấp <b>Dừng ghi</b> và đặt tên để lưu.</li>
        <li>Để phát lại, chọn mục đánh dấu <b>Macro</b> trong danh sách <b>Đoạn lệnh</b> trên thanh công cụ. Các phím đã ghi được gửi theo thứ tự, đúng như khi gõ.</li>
      </ol>
      <ul>
        <li><b>Nhiều thiết bị cùng lúc</b>: Gửi đoạn lệnh hoặc macro khi <b>Nhập đồng thời</b> đang bật ở trên cùng, nội dung sẽ tới mọi tab terminal đang kết nối.</li>
        <li><b>Đừng ghi mật khẩu</b>: Macro lưu phím đúng như khi gõ, nên mật khẩu nhập trong lúc ghi cũng bị lưu.</li>
        <li>Có thể xem nội dung macro trong <b>Quản lý đoạn lệnh…</b> (⏎ = Enter, ⇥ = Tab, ^C = Ctrl+C). Có thể đổi tên và xóa, nhưng không sửa được các phím; hãy ghi lại để thay đổi.</li>
        <li>Đoạn lệnh và macro được lưu trên PC này và dùng chung cho mọi phiên.</li>
      </ul>`,
  },
  {
    id: "monitor",
    title: "Nhận diện thiết bị · CPU · Bộ nhớ",
    icon: "Activity",
    body: `
      <p>Khi bạn kết nối qua SSH hoặc Telnet, một kết nối giám sát riêng sẽ tự động nhận diện loại thiết bị và hiển thị tên thiết bị cùng CPU/bộ nhớ (và ổ đĩa đối với máy chủ) trên thanh trạng thái. Không có gì được nhập vào terminal.</p>
      <p>Thiết bị được hỗ trợ: <b>Cisco</b> IOS · IOS-XE · NX-OS · ASA, <b>Fortinet</b> FortiGate, <b>Aruba</b> AOS-CX · AOS-Switch (ProCurve) · bộ điều khiển không dây, <b>Juniper</b> Junos, <b>Huawei</b> VRP, và máy chủ chạy <b>Linux (Red Hat v.v.)</b> · <b>AIX</b> · <b>HP-UX</b> · <b>Solaris</b>.</p>
      <ul>
        <li><b>Nút thiết bị</b>: Sau khi nhận diện, một nút mang tên thiết bị xuất hiện trên thanh công cụ terminal. Nhấp vào để nhập một lần các lệnh show thông dụng cho thiết bị đó (giao diện, định tuyến, VLAN, HA, nhật ký lỗi, v.v.). Không bao gồm lệnh thay đổi cấu hình.</li>
        <li><b>Sao lưu cấu hình</b>: Với thiết bị mạng, nút thiết bị → "Sao lưu cấu hình" lưu running-config (<code>show</code> trên FortiGate) vào tệp <code>devicename_datetime.cfg</code>. Việc đọc diễn ra qua kết nối giám sát, nên không làm gián đoạn terminal bạn đang dùng. Nếu thiết bị từ chối vì không đủ quyền hoặc không nhận được phần cuối của cấu hình (<code>end</code> trên IOS, <code>return</code> trên Huawei, v.v.), tệp sẽ không được lưu.</li>
        <li><b>Chế độ phím tự động</b>: Khi nhận diện được thiết bị mạng, các phiên chưa chọn chế độ phím sẽ chuyển sang chế độ thiết bị (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E).</li>
        <li><b>Tiến trình hàng đầu</b>: Nhấp CPU/bộ nhớ trên thanh trạng thái để xem 10 tiến trình dùng CPU và bộ nhớ nhiều nhất cùng danh sách ổ đĩa (Linux).</li>
        <li>Giám sát dùng thêm một lần đăng nhập. <b>Dù mở nhiều tab tới cùng thiết bị, chỉ dùng một kết nối giám sát</b> (để tiết kiệm đường VTY của thiết bị).</li>
        <li>Việc đọc diễn ra mỗi 2 giây trên Linux (10 giây nếu kết nối qua Telnet), 15 giây trên thiết bị mạng và 10 giây trên AIX/HP-UX/Solaris. Các lệnh giám sát không xuất hiện trong lịch sử shell của máy chủ (<code>~/.sh_history</code> v.v.). Nó tạm dừng khi không có tab nào của thiết bị đó trên màn hình hoặc cửa sổ bị thu nhỏ (thiết bị chỉ được kiểm tra 5 phút một lần để phiên đăng nhập không bị rớt), và đọc ngay khi hiển thị lại.</li>
        <li>Nếu xuất hiện "nhấp để đăng nhập", hãy nhấp vào và nhập mật khẩu cho việc giám sát (không được lưu). Nếu không biết mật khẩu, kết nối giám sát sẽ ngắt trước khi gửi tên người dùng, nên thiết bị không ghi lại lần đăng nhập thất bại nào. Với thiết bị Telnet vào được mà không cần mật khẩu, hãy để trống mật khẩu rồi bắt đầu. Nếu sau khi đăng nhập thiết bị còn hỏi thêm điều gì đó, như mã dùng một lần, việc giám sát sẽ không chạy. Để tắt: Cài đặt → Phiên.</li>
      </ul>`,
  },
  {
    id: "files",
    title: "Truyền tệp (SFTP · FTP · FTPS)",
    icon: "FolderOpen",
    body: `
      <ul>
        <li>Bên trái là PC của bạn và bên phải là máy chủ. Kéo các mục sang phía bên kia hoặc nhấp nút truyền. Thư mục được gửi kèm toàn bộ nội dung.</li>
        <li>Nếu đã có tệp cùng tên, bạn sẽ được hỏi có ghi đè không. Quá trình truyền hiển thị tiến độ và có thể hủy.</li>
        <li><b>TFTP</b>: Chọn TFTP làm loại phiên (hoặc trong Kết nối nhanh) để mở tab TFTP. TFTP không có đăng nhập và danh sách thư mục, nên hãy nhập <b>tên tệp trên máy chủ</b> rồi nhấp "Nhận", hoặc chọn một tệp trên PC rồi nhấp "Gửi". Kích thước khối "Tự động" phù hợp với hầu hết thiết bị, và máy chủ cũ không hiểu tùy chọn sẽ tự động lùi về 512. Để thiết bị gửi tệp tới PC của bạn (VD <code>copy running-config tftp:</code>), hãy bật <b>Máy chủ TFTP</b> trong nút "Máy chủ" ở trên cùng.</li>
        <li>Gửi thư mục qua SFTP sẽ truyền 4 tệp cùng lúc, nhanh hơn nhiều với thư mục có nhiều tệp nhỏ, đặc biệt qua khoảng cách xa. FTP gửi từng tệp một do giới hạn kết nối của máy chủ, nhưng bạn vẫn có thể duyệt thư mục trong lúc truyền.</li>
        <li>Nhấp đúp vào tệp văn bản trên máy chủ để mở trong trình soạn thảo tích hợp; khi lưu, tệp được ghi thẳng lên máy chủ.</li>
      </ul>`,
  },
  {
    id: "rdp",
    title: "Remote Desktop (RDP) · VNC",
    icon: "Monitor",
    body: `
      <ul>
        <li><b>Kích thước màn hình</b>: Nếu độ phân giải của phiên là "Tự động", nó khớp với kích thước tab. Đổi kích thước cửa sổ cũng đổi độ phân giải từ xa, và nếu máy chủ không hỗ trợ đổi trực tiếp thì sẽ tự động kết nối lại với kích thước mới.</li>
        <li><b>Vừa khung</b>: Chọn thu phóng màn hình từ xa cho vừa tab (bật) hoặc xem ở kích thước thực (tắt).</li>
        <li><b>Sao chép &amp; dán</b>: Giống mstsc, trao đổi văn bản, hình ảnh và <b>tệp, thư mục</b> giữa PC của bạn và PC từ xa bằng ${kbd("Ctrl+C")} / ${kbd("Ctrl+V")} (tùy chọn phiên "Chia sẻ clipboard"). Tệp sao chép ở phía từ xa được tải xuống khi bạn dán, tiến độ hiển thị trên thanh công cụ.</li>
        <li>Bàn phím: Loại và bố cục bàn phím của PC bạn (VD bàn phím tiếng Hàn 103/106 phím) được chuyển nguyên vẹn sang phía từ xa, nên Shift/Ctrl/Alt bên phải và các phím Hangul/Hanja hoạt động như trong mstsc. Trạng thái Num Lock và Caps Lock cũng được đồng bộ trên máy chủ, nên bàn phím số gõ được ở màn hình đăng nhập mà không cần nhấn lại Num Lock.</li>
        <li>Thanh công cụ: Gửi ${kbd("Ctrl+Alt+Del")}, phím Windows, Nhập clipboard (gửi văn bản trong clipboard dưới dạng phím gõ), Mở bằng mstsc.</li>
        <li>Lần kết nối đầu tiên, bạn xác minh dấu vân tay chứng chỉ máy chủ; sau khi tin cậy, bạn sẽ không bị hỏi lại.</li>
        <li>Khi bạn đang xem tab khác hoặc cửa sổ bị thu nhỏ, tab RDP đó ngừng vẽ, và tải toàn bộ màn hình một lần khi bạn quay lại.</li>
        <li><b>Tốc độ VNC</b>: Trong "Chất lượng" trên thanh công cụ, chọn Nhanh (mặc định: giảm màu/chất lượng, nén tối đa), Cân bằng hoặc Sắc nét (áp dụng ngay không cần ngắt kết nối). Bật "Thống kê truyền" để xem mã hóa máy chủ đang dùng và dữ liệu nhận mỗi giây. Nếu chỉ thấy Raw hoặc Hextile, máy chủ không dùng nén.</li>
        <li>Khi VNC chậm, nguyên nhân thường nằm ở <b>cài đặt máy chủ</b>. Với TightVNC Server: trong cài đặt máy chủ → tab Server, giảm <b>Screen polling cycle</b> từ 1000ms xuống 30–50ms, tắt <b>Grab transparent windows</b>, và bật <b>mirror driver (DFMirage)</b> nếu đã cài. Bỏ hình nền desktop cũng giúp ích nhiều. Trên màn hình lớn như 4K, TightVNC có thể trễ hàng chục giây (đo trên một PC: TightVNC trễ 34–46 giây, UltraVNC gần như thời gian thực). Khi đó hãy dùng <b>UltraVNC Server</b>, bật Windows desktop duplication (DDengine) trong tab Capture.</li>
        <li>RDP tích hợp không dùng tăng tốc đồ họa (H.264) của mstsc, nên có thể chậm hơn mstsc khi màn hình thay đổi nhiều. Khi đó hãy dùng "Mở bằng mstsc".</li>
      </ul>`,
  },
  {
    id: "tools",
    title: "Công cụ · Máy chủ tệp",
    icon: "Waypoints",
    body: `
      <ul>
        <li><b>SSH gateway</b>: Trong trình sửa phiên RDP, VNC hoặc Telnet, chọn một phiên SSH đã lưu làm gateway để truy cập thiết bị nằm sau tường lửa thông qua máy chủ đó.</li>
        <li><b>Đường hầm SSH</b>: Công cụ ở trên cùng → Đường hầm SSH. Lưu các chuyển tiếp cổng cục bộ → máy chủ SSH → địa chỉ đích và bật/tắt chúng.</li>
        <li><b>Công cụ mạng</b>: ping, kiểm tra cổng TCP (nhiều cổng và dải cổng), tra cứu DNS.</li>
        <li><b>Máy chủ tệp</b>: Nút máy chủ tệp ở trên cùng tạm thời chia sẻ một thư mục trên PC này qua FTP, TFTP hoặc HTTP (VD để tải image OS lên thiết bị).</li>
      </ul>`,
  },
  {
    id: "security",
    title: "Thông tin đăng nhập · Bảo mật",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>Kho thông tin đăng nhập</b> (nút chìa khóa ở trên cùng): Lưu mật khẩu và khóa SSH trong Windows Credential Manager để dùng trong trình sửa phiên. Mật khẩu đã lưu không bao giờ được hiển thị ra màn hình.</li>
        <li><b>Mật khẩu chính</b> (Cài đặt → Bảo mật): Khóa ứng dụng khi khởi động và sau khi bạn rời đi.</li>
        <li>Khóa máy chủ SSH/SFTP được đối chiếu với <code>~/.ssh/known_hosts</code>; khóa chưa biết sẽ hiển thị dấu vân tay để xác nhận. Khóa đã thay đổi sẽ chặn kết nối.</li>
      </ul>`,
  },
  {
    id: "update",
    title: "Cập nhật",
    icon: "RefreshCw",
    body: `
      <p>Khi khởi động và <b>mỗi 30 phút</b> trong lúc chạy (cả khi bạn quay lại cửa sổ sau một lúc), ứng dụng kiểm tra phiên bản mới trên <b>GitHub</b> (github.com/NijG/bananaconn). Với máy bị chính sách bảo mật chặn GitHub, hãy chỉ định <b>thư mục cập nhật NAS</b> (thư mục chia sẻ chứa các phiên bản mới) trong Cài đặt → Cập nhật; thư mục này được kiểm tra khi không kết nối được GitHub. Khi tìm thấy phiên bản mới, một <b>cửa sổ hỏi có cập nhật ngay không</b> sẽ hiện ra. "Cập nhật ngay" sẽ đóng ứng dụng, cài đặt rồi mở lại (các kết nối đang mở sẽ bị ngắt). Nếu chọn "Để sau", bạn có thể cài bất cứ lúc nào bằng nút <b>Cập nhật</b> bên phải thanh trạng thái. Cửa sổ chọn sẵn "Để sau", nên phím Enter gõ cho terminal không bao giờ bắt đầu cập nhật.</p>
      <p><b>Khi thất bại với lỗi "mật khẩu không đúng"</b>: Windows kết nối tới thư mục chia sẻ bằng tài khoản Windows bạn đang đăng nhập, và không chuyển sang truy cập khách ngay cả khi thư mục chia sẻ cho phép đọc ẩn danh (khách). Hãy mở thư mục cập nhật trong Explorer, nhập tài khoản NAS và đánh dấu "Remember my credentials", hoặc chọn một tài khoản từ kho thông tin đăng nhập trong <b>Tài khoản NAS</b> tại Cài đặt → Cập nhật. Ứng dụng sẽ đăng nhập bằng tài khoản đó.</p>
      <p>Chỉ các tệp được PC build ký mới được cài đặt, nên tệp do người khác đặt vào thư mục chia sẻ sẽ không được cài. Bạn cũng có thể kiểm tra ngay bằng "Kiểm tra ngay".</p>`,
  },
  {
    id: "keys",
    title: "Phím tắt",
    icon: "Keyboard",
    body: `
      <p>Có thể xem và thay đổi mọi phím tắt trong <b>Cài đặt → Phím tắt</b> (hoặc "Cài đặt phím tắt" trên màn hình chính). Các thao tác chưa có phím tắt (chia màn hình, tab thứ n, bật nhật ký…) cùng đoạn lệnh và macro cũng có thể được gán phím tắt mới; nút "Mặc định" của từng thao tác hoặc "Đặt lại tất cả về mặc định" sẽ hoàn tác. Bảng dưới đây là giá trị mặc định.</p>
      <table class="help-table">
        <tr><td>${kbd("F1")}</td><td>Hướng dẫn này (bên trong terminal, phím được gửi tới chương trình từ xa)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+N")}</td><td>Phiên mới</td></tr>
        <tr><td>${kbd("Ctrl+Shift+K")}</td><td>Chuyển tới Kết nối nhanh</td></tr>
        <tr><td>${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}</td><td>Tab tiếp theo / trước</td></tr>
        <tr><td>${kbd("Ctrl+F4")} · ${kbd("Ctrl+Shift+W")}</td><td>Đóng tab</td></tr>
        <tr><td>Nhấp đúp vào tab</td><td>Mở lại cùng phiên</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>Tìm trong terminal</td></tr>
        <tr><td>${kbd("Ctrl")}+cuộn chuột</td><td>Cỡ chữ terminal</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>Thu gọn thanh bên</td></tr>
        <tr><td colspan="2"><b>Trong danh sách phiên</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>Kết nối / Sửa / Xóa (áp dụng cho tất cả khi chọn nhiều mục)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>Sao chép / dán phiên</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+nhấp, ${kbd("Ctrl+A")}</td><td>Chọn nhiều</td></tr>
      </table>`,
  },
];
