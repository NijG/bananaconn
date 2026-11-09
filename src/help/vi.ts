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
      <p>Lưu thông tin kết nối bằng nút ${icon("Plus", 13)} trong danh sách phiên (${kbd("Ctrl+Shift+N")}), sau đó kết nối bằng cách nhấp đúp hoặc nhấn ${kbd("Enter")}. Các kết nối đã lưu trong chương trình khác có thể chuyển sang một lần bằng <a data-goto="import">Nhập</a>. Trong trình sửa phiên, <b>Kiểm tra kết nối</b> cho biết cổng của máy chủ có mở không trước khi lưu. Phiên đã lưu có thể kiểm tra từ menu chuột phải; nhiều phiên hoặc cả thư mục thì chọn chúng hoặc nhấp chuột phải vào thư mục để kiểm tra một lần. Trong kết quả, bạn có thể chỉ kiểm tra lại các phiên thất bại hoặc sao chép bảng, và nhấp đúp vào một dòng (hoặc nhấn Enter trên dòng đó) để kết nối ngay phiên đó.</p>
      <h4>Ngôn ngữ giao diện</h4>
      <p><b>Ngôn ngữ</b> ở đầu Cài đặt chuyển giao diện sang 한국어, English, 日本語, 简体中文, 繁體中文, Tiếng Việt, Español, Français hoặc Deutsch (ngay lập tức, không ngắt kết nối; hướng dẫn và ghi chú cập nhật cũng đổi theo). Cho đến khi bạn chọn, ứng dụng theo ngôn ngữ hiển thị của Windows; khi đã chọn, lựa chọn của bạn luôn được ưu tiên.</p>
      <h4>Tìm một cài đặt</h4>
      <p>Gõ một từ vào <b>Tìm trong cài đặt</b> ở góc trên bên trái hộp thoại cài đặt: các cài đặt khớp ở mọi trang được liệt kê, chọn một mục sẽ chuyển tới đó. Cũng có thể tìm bằng từ tiếng Anh (vd: reconnect, font).</p>`,
  },
  {
    id: "sessions",
    title: "Danh sách phiên",
    icon: "Server",
    body: `
      <ul>
        <li><b>Thư mục</b>: Trong trình sửa phiên, ghi thư mục bằng dấu gạch chéo, như <code>Prod/Web servers</code>, để tạo thư mục con. Bạn cũng có thể kéo phiên thả vào thư mục để di chuyển.</li>
        <li><b>Sắp xếp và thứ tự</b>: Nút sắp xếp phía trên danh sách phiên cho phép chọn theo tên (AP2 trước AP10), theo địa chỉ (so sánh IP theo số), kết nối gần đây hoặc tùy chỉnh. Kéo một phiên lên trên hoặc xuống dưới phiên khác để đặt nó vào đó; thư mục cũng được đổi thứ tự, hoặc chuyển vào thư mục khác, theo cách tương tự. Đổi thứ tự sẽ chuyển sang thứ tự tùy chỉnh và giữ nguyên thứ tự đó. ${kbd("Alt+Up")} / ${kbd("Alt+Down")} chuyển phiên đang chọn lên hoặc xuống một vị trí, và "Sắp xếp thư mục này theo tên/địa chỉ" trong menu thư mục sắp xếp lại một lần.</li>
        <li><b>Tìm kiếm</b>: Nhập một phần tên, máy chủ, người dùng hoặc ghi chú vào ô tìm kiếm ở trên cùng. ${kbd("Enter")} kết nối ngay khi chỉ có một kết quả; nếu có nhiều, nó chuyển đến kết quả đầu tiên giống ${kbd("Down")}, tại đó ${kbd("Enter")} để kết nối. ${kbd("Esc")} xóa từ khóa. Nếu không có phiên khớp và từ khóa là một địa chỉ (IP, user@host:port v.v.), ${kbd("Enter")} hoặc "Phiên mới với địa chỉ này…" sẽ mở phiên mới đã điền sẵn địa chỉ đó.</li>
        <li><b>Ghi chú phiên</b>: khi một phiên có ghi chú trong trình sửa (cảnh báo, vị trí, người phụ trách …), các tab của phiên đó (terminal, tệp, máy tính từ xa, VNC, TFTP) hiện nút ghi chú ở đầu thanh công cụ: nhấp để đọc trong lúc làm việc, và "Sửa ghi chú" để thay đổi.</li>
        <li><b>Chọn nhiều</b>: ${kbd("Ctrl")}+nhấp để chọn từng mục, ${kbd("Shift")}+nhấp để chọn một dải. ${kbd("Shift+↑/↓")} và ${kbd("Ctrl+A")} cũng dùng được. ${kbd("Esc")} bỏ chọn.</li>
        <li><b>Ghim vào màn hình chính</b>: Nhấp chuột phải vào phiên → Ghim vào màn hình chính để phiên luôn hiện, theo tên, trong "Phiên đã ghim" ở màn hình chính khi không có tab nào mở. Bỏ ghim trong cùng menu, hoặc nhấp chuột phải vào phiên trên màn hình chính để kết nối, sửa, sao chép địa chỉ hay bỏ ghim. Có thể chọn nhiều phiên để ghim hoặc bỏ ghim cùng lúc, và phiên đã ghim hiện trước trong bảng lệnh.</li>
        <li><b>Thao tác hàng loạt</b>: Khi chọn nhiều mục, nhấp chuột phải → Sửa hàng loạt (${kbd("F2")}: người dùng, cổng, thông tin đăng nhập, thư mục, chế độ phím, máy chủ trung gian (SSH), cổng SSH (Telnet, RDP, VNC)), Di chuyển vào thư mục, Sao chép địa chỉ (mỗi dòng một địa chỉ), Xóa (${kbd("Del")}), Kết nối tất cả (${kbd("Enter")}; nhiều hơn 10 phiên thì hỏi trước). Nhấp chuột phải vào thư mục → "Kết nối tất cả N phiên trong thư mục này" mở cả thư mục con theo thứ tự đang hiển thị.</li>
        <li><b>Sao chép &amp; dán</b>: Chọn phiên và nhấn ${kbd("Ctrl+C")}, chọn một phiên trong thư mục đích và nhấn ${kbd("Ctrl+V")}. Mỗi lần dán tạo một phiên mới tên "Tên (2)", "Tên (3)". Nhấp chuột phải → Nhân bản cũng tương tự.</li>
        <li><b>Sửa</b>: ${kbd("F2")} hoặc nhấp chuột phải → Sửa. Nếu đã có phiên cùng giao thức, máy chủ, cổng và người dùng, tên của phiên đó hiện dưới ô Máy chủ (không chặn việc lưu).</li>
      </ul>`,
  },
  {
    id: "import",
    title: "Nhập từ chương trình khác",
    icon: "Download",
    body: `
      <p>Chọn từ nút ${icon("Download", 13)} phía trên danh sách phiên. Danh sách xem trước được hiển thị trước khi nhập, và các phiên đã có sẽ được bỏ qua. <b>Mật khẩu không được nhập</b> (mỗi chương trình mã hóa bằng khóa riêng). Hãy nhập khi kết nối lần đầu hoặc gán từ kho thông tin đăng nhập. Các phiên đăng nhập bằng khóa công khai được liên kết với tệp khóa trong kho thông tin đăng nhập, và các tệp khóa không tìm thấy hoặc không dùng được sẽ được báo trước khi nhập.</p>
      <table class="help-table">
        <tr><th>Chương trình</th><th>Cần chọn</th></tr>
        <tr><td>MobaXterm</td><td><code>%APPDATA%\\MobaXterm\\MobaXterm.ini</code> (bản portable: cạnh tệp thực thi)</td></tr>
        <tr><td>SecureCRT</td><td>Thư mục phiên <code>%APPDATA%\\VanDyke\\Config\\Sessions</code> (gồm cấu trúc thư mục, tên tệp nhật ký, cài đặt tự động ghi nhật ký và tệp khóa dùng để đăng nhập bằng khóa công khai, và tường lửa đi qua phiên khác thành máy chủ trung gian, mô tả phiên thành ghi chú, và khoảng gửi NO-OP của phiên SSH thành khoảng giữ kết nối), hoặc tệp XML tạo bằng File → Export Settings</td></tr>
        <tr><td>mRemoteNG</td><td><code>%APPDATA%\\mRemoteNG\\confCons.xml</code> (nếu bật mã hóa toàn bộ tệp, hãy tắt và lưu trước)</td></tr>
        <tr><td>PuTTY · KiTTY</td><td>Đọc trực tiếp cài đặt trên PC này (gồm cả tệp khóa của từng phiên, chuyển tiếp cổng, chuyển tiếp agent, nén và khoảng giữ kết nối)</td></tr>
        <tr><td>WinSCP</td><td>Cài đặt trên PC này, hoặc <code>WinSCP.ini</code> nếu không có (gồm cả tệp khóa)</td></tr>
        <tr><td>Xshell</td><td>Thư mục <code>Documents\\NetSarang Computer\\&lt;version&gt;\\Xshell\\Sessions</code>. Không thể liên kết khóa trong kho khóa của Xshell: hãy xuất khóa ở định dạng OpenSSH từ trình quản lý khóa người dùng của Xshell rồi chỉ định trong Kho thông tin đăng nhập</td></tr>
        <tr><td>OpenSSH</td><td>Tệp <code>.ssh\\config</code> (Host, HostName, User, Port, ProxyJump, IdentityFile, LocalForward, RemoteForward, DynamicForward, ForwardAgent, Compression, ServerAliveInterval; giống ssh, áp dụng mọi khối Host khớp và giá trị đầu tiên được dùng, còn chuyển tiếp cổng của mọi khối khớp đều được gộp lại; ký tự đại diện như <code>Host *</code> chỉ cung cấp giá trị mặc định, không tạo phiên)</td></tr>
        <tr><td>RDCMan</td><td>Tệp <code>.rdg</code></td></tr>
        <tr><td>Remote Desktop</td><td>Thư mục chứa tệp <code>.rdp</code> (bao gồm thư mục con)</td></tr>
        <tr><td>CSV</td><td>Tên cột ở dòng đầu: Name, Protocol, Host, Port, Username, Folder, Domain (phân tách bằng dấu phẩy, dấu chấm phẩy hoặc tab). <b>Xuất danh sách phiên (CSV)</b> trong cùng menu ghi theo định dạng này.</td></tr>
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
        <li><b>Menu tab</b>: Nhấp chuột phải vào tab để kết nối lại, sửa phiên (tab kết nối nhanh thì lưu thành phiên), sao chép địa chỉ (user@host:port), đổi tên tab (giữ đến khi đóng tab; để trống để về tên gốc), đóng các tab khác hoặc đóng các tab bên phải.</li>
        <li><b>Chuyển tab</b>: ${kbd("Ctrl+Tab")} / ${kbd("Ctrl+Shift+Tab")}. Khi có nhiều tab, cuộn chuột trên thanh tab để di chuyển sang trái và phải. Kéo tab để sắp xếp lại. Nhập tên hoặc địa chỉ của tab vào bảng lệnh (${kbd("Ctrl+K")}) để chuyển ngay đến tab đang mở. Bảng lệnh cũng liệt kê các tab vừa đóng để mở lại, và nhấp vào số tab trên thanh trạng thái cũng mở bảng lệnh.</li>
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
        <li><b>Sao chép &amp; dán</b>: Kéo để chọn sẽ sao chép ngay, nhấp chuột phải để dán (có thể đổi trong Cài đặt). ${kbd("Ctrl+C")} chỉ sao chép khi có vùng chọn; nếu không, nó được gửi tới thiết bị. Khi tắt tùy chọn này, nhấp chuột phải sẽ mở menu Sao chép, Dán, Chọn tất cả, Tìm và Xóa màn hình.</li>
        <li><b>Địa chỉ IP trong đầu ra</b>: Địa chỉ IPv4 trong đầu ra của terminal (show arp, show ip int brief, ip route, traceroute…) hoạt động như liên kết: ${kbd("Ctrl")}+nhấp (hoặc nhấp, tùy cài đặt) mở menu để tạo phiên mới cho địa chỉ đó (cửa sổ sửa mở sẵn thông tin; chỉ kết nối sau khi lưu), mở công cụ mạng (ping, cổng, DNS) hoặc sao chép địa chỉ. Mặt nạ mạng (255.x.x.x) và 0.0.0.0 không được tính. Mục "Tính subnet" trong menu hiển thị mạng, broadcast, dải sử dụng được, số host và mặt nạ của địa chỉ, dùng tiền tố viết ngay sau nó (/24, mặt nạ như 255.255.255.0 hoặc 0xffffff00, hoặc wildcard ACL như 0.0.0.255) nếu có. Địa chỉ MAC (aa:bb:cc:dd:ee:ff, aabb.ccdd.eeff…) cũng dùng như vậy: sao chép theo định dạng Linux, Windows, Cisco hoặc Huawei, hoặc dùng "Tìm MAC này ở mọi định dạng" để tìm trên màn hình dù viết theo kiểu nào.</li>
        <li><b>Chuyển giữa các lệnh</b>: Mỗi lệnh nhập tại dấu nhắc được ghi nhớ theo dòng, nên với đầu ra dài ${kbd("Ctrl+Shift+↑")} / ${kbd("Ctrl+Shift+↓")} cuộn thẳng đến dòng của lệnh trước hoặc sau và tô sáng dòng đó trong giây lát. Đi quá lệnh cuối sẽ quay về cuối đầu ra. Không ghi nhớ trong các chương trình toàn màn hình như vi hay less, và nội dung đã gõ không được lưu. Lệnh chạy lâu hơn 2 giây sẽ hiện thời gian đã chạy (⏱ 12.4s) ở cuối dòng của nó khi dấu nhắc xuất hiện lại. ${kbd("Ctrl+Shift+O")} chỉ sao chép đầu ra của lệnh cuối (hoặc lệnh đã nhảy tới theo cách này), không cần kéo chọn đầu ra dài; lệnh còn đang chạy thì sao chép đầu ra đến lúc đó. "So sánh với lần chạy trước" trong menu chuột phải mở cửa sổ so sánh giữa đầu ra này và đầu ra của cùng lệnh đã nhập trước đó tại cùng dấu nhắc (ví dụ kết quả show trước và sau khi thay đổi). Chỉ tìm trong đầu ra còn trong terminal; có thể gán phím tắt trong Cài đặt.</li>
        <li><b>So sánh đầu ra</b>: Chọn một đoạn đầu ra và nhấn ${kbd("Ctrl+Shift+D")} để lấy làm phần thứ nhất; chọn ở tab khác (hoặc phần khác của cùng tab) rồi nhấn lại để so sánh hai phần theo từng dòng, chẳng hạn cấu hình của hai switch hoặc đầu ra show trước và sau khi thay đổi. Dòng thêm có màu xanh lá, dòng xóa màu đỏ, phần giống nhau được thu gọn và có thể bỏ qua khác biệt khoảng trắng. "So sánh đầu ra" trong bảng lệnh (${kbd("Ctrl+K")}) mở cửa sổ so sánh trống để dán vào. Mọi thứ diễn ra trong cửa sổ này; không gửi gì đến thiết bị. "Tệp…" phía trên mỗi bên tải một tệp văn bản, như bản sao lưu cấu hình đã lưu, để so sánh với đầu ra hiện tại; "Đổi hai bên" hoán đổi hai bên. "Sao chép kết quả" sao chép phần khác biệt thành văn bản có dấu +/-, tiện dán vào nhật ký thay đổi.</li>
        <li><b>Sao chép dạng bảng</b>: chọn một bảng như show ip interface brief, show mac address-table hay df -h từ dòng tiêu đề rồi nhấn ${kbd("Ctrl+Shift+X")}: bảng được sao chép, tách thành cột theo vị trí các từ của dòng tiêu đề và phân cách bằng tab, nên khi dán vào Excel mỗi giá trị nằm ở một ô. Đọc nguyên dòng, cột vẫn thẳng hàng với ký tự rộng, và giá trị bắt đầu bằng = hoặc - được thêm ' phía trước để không bị chạy như công thức.</li>
        <li><b>Lặp lại lệnh</b>: "Lặp lại lệnh…" trong menu đoạn lệnh trên thanh công cụ gửi lại cùng một lệnh (vd: show interface counters) theo khoảng cách (giây) và số lần đã đặt, để theo dõi giá trị thay đổi trên thiết bị mạng không có watch. Mỗi lần chỉ gửi khi kết quả trước đã xong và cùng dấu nhắc đã quay lại; nhập vào tab này, mất kết nối, dấu nhắc đăng nhập hoặc mật khẩu, phân trang (--More--) hay một dấu nhắc khác sẽ dừng ngay. Không thể lặp lại lệnh khớp với quy tắc lệnh nguy hiểm.</li>
        <li><b>Hẹn giờ công việc</b>: "Hẹn giờ công việc…" trong menu đoạn lệnh trên thanh công cụ hoặc menu chuột phải nhận thời gian theo phút và ghi chú (ví dụ: nhập reload cancel). Thẻ hiển thị thời gian còn lại, và một phút trước khi hết giờ cũng như khi hết giờ sẽ có âm thanh và thông báo (thông báo của Windows nếu ứng dụng đang ở nền). Dùng cho công việc phải hủy hoặc xác nhận đúng hạn như <code>reload in 10</code> hay <code>commit confirmed 10</code>. Nó không gửi lệnh nào, vẫn chạy khi mất kết nối, và sẽ hỏi lại khi đóng thẻ còn hẹn giờ. Hẹn giờ đã hết vẫn hiện 0:00 trên thẻ cho đến khi bạn nhấn phím hoặc bấm vào thẻ đó, và nút trên thanh tác vụ sẽ nhấp nháy nếu ứng dụng đang ở nền. Khi nhập <code>reload in 10</code> hoặc <code>commit confirmed</code> tại dấu nhắc, ứng dụng sẽ đề nghị bật hẹn giờ với thời gian và ghi chú đã điền sẵn; khi nhập <code>reload cancel</code> hoặc <code>commit</code> trong lúc hẹn giờ đang chạy, ứng dụng sẽ đề nghị dừng nó (chỉ đề nghị, không tự bật hay dừng). Số sau <code>commit confirmed</code> chỉ được hiểu là phút khi thiết bị được nhận diện là Junos.</li>
        <li><b>Liên kết</b>: ${kbd("Ctrl")}+nhấp vào địa chỉ trong đầu ra để mở bằng trình duyệt (nhấp thường dùng để chọn và lấy tiêu điểm). Trong Cài đặt → Terminal có thể cho phép nhấp thường để mở liên kết.</li>
        <li><b>Cỡ chữ</b>: ${kbd("Ctrl")}+cuộn chuột, hoặc ${icon("ZoomIn", 13)}${icon("ZoomOut", 13)} trên thanh công cụ.</li>
        <li><b>Tìm</b>: ${kbd("Ctrl+Shift+F")}. Nút danh sách trên thanh tìm (hoặc ${kbd("Alt+Enter")}) gom mọi dòng khớp: chỉ đọc những dòng đó trong đầu ra dài hoặc "Sao chép tất cả", không cần chạy lại lệnh với "| include" trên thiết bị; nhấp một dòng để tới vị trí đó trong terminal. Áp dụng thiết lập phân biệt hoa thường và regex. "Trong mọi thẻ terminal" trong danh sách đó sẽ tìm trong mọi thẻ terminal đang mở và nhóm các dòng theo thẻ; nhấp một dòng để tới vị trí đó trong thẻ của nó. Menu của địa chỉ MAC hoặc IP trong đầu ra cũng có "Tìm trong mọi thẻ terminal": sau khi gửi cùng một lệnh tới nhiều switch, bạn thấy ngay bảng MAC hoặc ARP của thiết bị nào có địa chỉ đó (MAC ở mọi cách viết; IP chỉ khi là địa chỉ đầy đủ, không phải một phần của địa chỉ dài hơn).</li>
        <li><b>Thời điểm nhận một dòng</b>: nhấp chuột phải trong terminal, cuối menu sẽ hiện thời điểm nhận dòng dưới con trỏ (nhấp để sao chép). Dùng để xem thông báo console của thiết bị hoặc phản hồi ping không in giờ đã đến lúc nào. Chính xác đến giây, có thêm ngày nếu không phải hôm nay. Dòng được vẽ lại tại chỗ (thanh tiến trình) hiện thời điểm xuất hiện lần đầu; không có trong chương trình toàn màn hình như vi hoặc less, hoặc với các dòng trước khi xóa màn hình (khi bật "Nhấp chuột phải để dán", menu không mở).</li>
        <li><b>Chế độ phím</b>: Nếu Delete, Home hoặc End in ra <code>~</code> trên thiết bị như Cisco IOS, hãy chuyển thanh công cụ sang "Phím: Thiết bị" (Delete=Ctrl-D, Home=Ctrl-A, End=Ctrl-E). Có thể đặt mặc định trong trình sửa phiên.</li>
        <li><b>Nối tiếp</b>: Trong trình sửa phiên, đặt cổng COM ("Tìm cổng"), tốc độ, chẵn lẻ và điều khiển luồng. Nút Break trên thanh công cụ gửi tín hiệu Break. Khi dán nhiều dòng hoặc gửi cấu hình bằng "Gửi tệp văn bản" trên thanh công cụ, từng dòng được gửi lần lượt: mỗi dòng đi ngay khi thiết bị đã nhận dòng trước và hiện lại dấu nhắc, nên thiết bị nhanh nhận nhanh còn thiết bị chậm không bị mất ký tự. Tiến độ được hiển thị trong khi gửi; ${kbd("Ctrl+C")}, Break hoặc "Dừng" trong ô tiến độ sẽ bỏ các dòng còn lại. Với thiết bị không phản hồi lại đầu vào, chọn độ trễ cố định trong Cài đặt → Terminal. Phiên Telnet qua console server cũng hoạt động như vậy khi bật "Kết nối console server" trong trình chỉnh sửa phiên. Trong phiên Telnet, nút Break trên thanh công cụ gửi lệnh Break của Telnet, và console server chuyển nó thành tín hiệu Break tới cổng của thiết bị. Khi bộ chuyển đổi USB nối tiếp bị rút, tab sẽ chờ cổng và tự kết nối lại ngay khi được cắm lại. Nhập/xuất cổng dùng chế độ nhanh, trong đó phím gõ không phải chờ thao tác đọc; nếu trình điều khiển có vấn đề, hãy chuyển sang chế độ tương thích trong Cài đặt → Terminal.</li>
        <li><b>Gửi nhiều dòng tới console đang chờ đăng nhập</b>: khi đang gửi từng dòng tới console thiết bị, nếu thiết bị hỏi tên đăng nhập (ví dụ console đã đăng xuất vì hết thời gian chờ và được dòng đầu tiên đánh thức), việc dán sẽ dừng để các dòng còn lại không bị nhập làm tên người dùng và mật khẩu rồi đăng nhập thất bại; hãy đăng nhập rồi gửi lại. Việc dán cũng dừng ở câu hỏi mật khẩu (kể cả sudo và su), trừ khi thiết bị hỏi ngay ở dòng sau khi gửi <code>enable</code> tại dấu nhắc &gt; của thiết bị (dán enable cùng mật khẩu). Nếu enable không hỏi mật khẩu (đã ở chế độ đặc quyền, hoặc chưa đặt mật khẩu), dòng tiếp theo trông giống mật khẩu sẽ được bỏ qua kèm thông báo thay vì gửi như một lệnh: nếu là lệnh, thiết bị sẽ tra nó như tên máy chủ và mật khẩu sẽ lộ trên mạng và trong nhật ký. Dòng tiếp theo chỉ được gửi khi dấu nhắc của thiết bị xuất hiện lại. Việc gửi cũng tiếp tục khi thiết bị đặt câu hỏi (<code>[confirm]</code>, <code>(yes/no)?</code>...) hoặc đang nhận văn bản như khi nhập banner; còn ở console đã đăng xuất ("Press RETURN to get started"), ở chế độ phân trang như <code>--More--</code>, hoặc khi dấu nhắc không quay lại trong 60 giây, việc dán sẽ dừng và các dòng còn lại không được gửi. Dán nhiều dòng hoặc gửi đoạn mã tới thẻ chưa đăng nhập, hoặc tới console đang chờ ở "Press RETURN to get started", sẽ được hỏi trước, và không bao giờ gửi nhiều dòng vào câu hỏi đăng nhập, mật khẩu hoặc khóa máy chủ.</li>
        <li><b>Tô sáng từ khóa đầu ra</b>: ERROR·FAIL màu đỏ, WARN màu vàng, OK·SUCCESS màu xanh lá.</li>
        <li><b>Kết xuất</b> (Cài đặt → Terminal): "Tự động" vẽ bằng GPU (WebGL) trên PC có card đồ họa, giúp tăng tốc khi đầu ra nhiều, và dùng trình kết xuất tiêu chuẩn trên máy chủ và phiên từ xa không có card đồ họa. Chỉ các terminal đang hiển thị trên màn hình mới dùng GPU.</li>
        <li><b>Đoạn lệnh &amp; macro</b>: Lưu các lệnh hay dùng trong Đoạn lệnh trên thanh công cụ, và dùng "Ghi" để ghi lại dữ liệu nhập rồi phát lại.</li>
        <li><b>Tệp</b> (SSH): Nút Tệp trên thanh công cụ mở khung SFTP của cùng máy chủ ở bên cạnh.</li>
        <li><b>Tự động kết nối lại</b> (có thể tắt trong Cài đặt): khi một phiên SSH hoặc Telnet đã đăng nhập bị rớt, ứng dụng chờ một lát rồi kết nối lại, và chờ lâu hơn mỗi lần vẫn thất bại. Kết nối đăng nhập không thành công hoặc bị ngắt trong lúc đăng nhập sẽ không kết nối lại: kết nối lặp lại với mật khẩu sai có thể khiến máy chủ chặn bạn. Sửa thông tin đăng nhập bằng <b>Sửa phiên</b> trong hộp thoại đăng nhập thất bại sẽ kết nối lại tab đó ngay, và khi kết nối lại luôn dùng cài đặt phiên đã lưu mới nhất.</li>
      </ul>`,
  },
  {
    id: "broadcast",
    title: "Nhập đồng thời",
    icon: "Radio",
    body: `
      <p>Bật <b>Nhập đồng thời</b> ở trên cùng, các phím gõ trong terminal hiện tại cũng được gửi tới các thẻ terminal đang kết nối khác (kể cả thẻ không hiển thị). Thẻ nào nhận được xác định theo từng dòng bằng các quy tắc bên dưới, và chấm của thẻ nhận chuyển sang màu vàng. Dùng khi nhập cùng lệnh trên nhiều thiết bị; nhớ tắt khi xong. Mỗi thẻ gửi Delete, Home, End theo chế độ phím của riêng nó (chuẩn/thiết bị).</p>
      <p>Nhập đồng thời chỉ đi giữa các thẻ có con trỏ ở cùng loại dòng khi bắt đầu gõ một dòng: shell đã đăng nhập, trước khi đăng nhập, câu hỏi tên người dùng, câu hỏi mật khẩu (kể cả enable và sudo) hoặc câu hỏi khóa máy chủ. Các thẻ nhận được xác định lúc đó và giữ đến khi nhấn Enter (khi bật, bắt đầu từ dòng tiếp theo); thẻ nào đổi sang loại dòng khác lúc Enter tới (console quay lại câu hỏi đăng nhập) thì không nhận Enter. Nhờ vậy lệnh không bị nhập làm mật khẩu ở thẻ vừa kết nối lại (mỗi lần là một lần đăng nhập thất bại) và mật khẩu không hiện ra trong shell của thẻ khác. Câu hỏi xác nhận của lệnh ([y/N], [confirm], v.v.) cũng là một loại riêng, nên câu trả lời chỉ tới các thẻ ở cùng câu hỏi; các thẻ chưa đăng nhập chỉ trao đổi Enter hoặc Ctrl+C để đánh thức thiết bị. Thẻ bị đầu ra chuyển sang loại dòng khác trong lúc đang gõ một dòng (câu hỏi mật khẩu, dấu nhắc sau khi hết thời gian) sẽ không nhận phần còn lại của dòng đó, và không bao giờ gửi nội dung dán hoặc đoạn mã nhiều dòng vào câu hỏi đăng nhập hoặc mật khẩu.</p>
      <p>Để chỉ gửi tới một số thẻ, nhấp chuột phải vào các thẻ còn lại và chọn <b>Loại khỏi nhập đồng thời</b>. Thẻ bị loại không nhận cũng không gửi nhập đồng thời, và khi nhập đồng thời đang bật, chấm của thẻ hiện thành vòng tròn rỗng. Chọn <b>Đưa lại vào nhập đồng thời</b> trong cùng menu để hoàn tác (giữ cho đến khi đóng thẻ).</p>`,
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
      <p><b>Đoạn lệnh tích hợp theo OS</b>: các lệnh kiểm tra chỉ đọc thông dụng (không thay đổi gì) cho Linux, AIX, HP-UX, Solaris, Windows, Cisco IOS · NX-OS · ASA, FortiGate, Aruba, Juniper và Huawei, cùng tổng đài điện thoại (PBX): Avaya CM, Cisco CUCM, Cisco CME·CUBE và Asterisk·FreePBX. Danh sách đoạn lệnh hiển thị trước tiên các đoạn lệnh của bạn và của OS được nhận diện trong tab đó; các hệ thống khác chỉ cách một cú nhấp trong "Đoạn lệnh …". Sửa, xóa hoặc đổi nhóm OS của chúng trong Quản lý đoạn lệnh.</p>
      <p><b>Lệnh nguy hiểm</b>: mọi dòng mà đoạn lệnh hoặc macro gửi đi đều được kiểm tra theo các quy tắc trong Cài đặt → Lệnh nguy hiểm. Các lệnh thay đổi thời gian hoặc NTP (<code>timedatectl set-ntp</code>, <code>date -s</code>, <code>ntpdate</code>, <code>ntp server</code>, <code>clock set</code> …) bị <b>chặn</b> và không bao giờ được gửi; các lệnh như khởi động lại, xóa, định dạng hoặc thay đổi cấu hình thiết bị cần xác nhận trong <b>cảnh báo</b> trước. Khi gửi, nhật ký của tab đó được bật, và mọi lần thử, hủy và chặn đều được ghi vào <code>risky-commands.log</code> trong thư mục nhật ký. Các lệnh nối bằng <code>;</code> hoặc <code>&amp;&amp;</code>, lệnh bên trong <code>sudo</code>, <code>su -c</code>, <code>bash -c</code> hoặc <code>eval</code>, và các dòng nối tiếp bằng <code>\\</code> ở cuối dòng cũng được kiểm tra. Macro có tự hoàn thành bằng Tab hoặc phím di chuyển con trỏ (←→, Home, lịch sử lệnh ↑↓) sẽ bị cảnh báo, vì không thể biết lệnh thực sự được gửi. Các lệnh bạn tự gõ cũng được kiểm tra: khi nhấn Enter, dòng lệnh hiện trên màn hình được so với cùng các quy tắc (kể cả lịch sử lệnh ↑↓ và tự hoàn thành bằng Tab). Chương trình toàn màn hình như vi hoặc less không bị kiểm tra, và có thể tắt việc kiểm tra trong Cài đặt → Lệnh nguy hiểm.</p>
      <p><b>Màu và gợi ý khi gõ lệnh</b>: lệnh gõ sau dấu nhắc được tô màu theo lệnh, tùy chọn, chuỗi, đường dẫn và ký hiệu nối, và chuyển sang đỏ trước khi nhấn Enter nếu khớp quy tắc lệnh nguy hiểm. Phần còn lại của lệnh được gợi ý bằng màu xám từ các lệnh đã chạy (chỉ lưu trên PC này) và từ đoạn lệnh mẫu: <kbd>→</kbd> hoặc <kbd>End</kbd> để nhập tất cả, <kbd>Ctrl</kbd>+<kbd>→</kbd> để nhập từng từ. <kbd>Tab</kbd> vẫn là tự hoàn thành của máy chủ. <kbd>Ctrl</kbd>+<kbd>Space</kbd> mở danh sách gợi ý (↑↓ để chọn, Enter hoặc Tab để nhập, Esc để đóng). Gợi ý lấy từ lịch sử, đoạn lệnh mẫu, từ điển lệnh của thiết bị đã nhận diện (Linux, AIX, HP-UX, Solaris, Windows, Cisco, FortiGate, Aruba, Juniper, Huawei) và, với máy chủ Unix đang bật giám sát tài nguyên, tên chương trình trong PATH của máy chủ. Các tên này được đọc một lần qua kết nối giám sát; không có gì được gõ vào terminal. Dòng lệnh được đọc từ màn hình nên mật khẩu (không hiển thị) không bao giờ được ghi lại, và lệnh nguy hiểm và lệnh chứa mật khẩu hoặc token (<code>mysql -p…</code>, <code>--password=…</code>, <code>TOKEN=…</code>) không được ghi lại cũng không được gợi ý; nhấn <kbd>Shift</kbd>+<kbd>Delete</kbd> trong danh sách gợi ý để xóa một mục gõ sai. Có thể tắt từng tính năng và xóa lịch sử lệnh trong Cài đặt → Terminal.</p>
      <p><b>Màu danh sách ls</b>: trên máy chủ mà ls không tô màu như AIX, HP-UX, Solaris, thư mục (xanh dương), tệp thực thi (xanh lá), liên kết (xanh lơ) và tệp nén (đỏ) vẫn được tô màu như trên Linux. ls -l và ls -F được đọc từ đầu ra; với ls thường, thư mục được đọc riêng qua kết nối giám sát tài nguyên (khi dấu nhắc hiển thị đường dẫn). Không gửi gì vào terminal, và danh sách do máy chủ tự tô màu được giữ nguyên. Tắt trong Cài đặt → Terminal.</p>
      <h4>Tạo và gửi đoạn lệnh</h4>
      <ol>
        <li>Trên thanh công cụ terminal: <b>Đoạn lệnh</b> → <b>Quản lý đoạn lệnh…</b> → <b>Đoạn lệnh mới</b>.</li>
        <li>Nhập tên và nội dung cần gửi. Nhiều dòng sẽ được gửi lần lượt từng dòng kèm Enter (VD <code>terminal length 0</code> rồi <code>show running-config</code> ở dòng tiếp theo).</li>
        <li>Khi bật <b>Nhấn Enter sau khi gửi</b>, dòng cuối được chạy ngay; khi tắt, lệnh chỉ được gõ vào và chờ.</li>
        <li>Để gửi, nhấp <b>Đoạn lệnh</b> trên thanh công cụ và chọn từ danh sách.</li>
        <li>Giá trị thay đổi mỗi lần gửi được viết là <code>{{?tên}}</code> (ví dụ: <code>show interface {{?cổng}}</code>, <code>ping {{?đích}} repeat {{?số_lần=100}}</code>). Khi gửi, một cửa sổ sẽ hỏi các giá trị và cho xem trước chính xác nội dung sẽ gửi. Phần sau <code>=</code> là giá trị mặc định, và tên dùng nhiều lần chỉ được hỏi một lần. Giá trị nhập gần nhất được nhớ cho đến khi đóng ứng dụng.</li>
      </ol>
      <h4>Ghi và phát macro</h4>
      <ol>
        <li>Nhấp <b>Ghi</b> trên thanh công cụ terminal; nút chuyển thành <b>Dừng ghi</b> và mọi phím bạn gõ từ lúc đó được lưu nguyên vẹn (kể cả Enter, Tab, phím Ctrl, phím mũi tên và nhập từ IME).</li>
        <li>Gõ lệnh trên thiết bị như bình thường. Các đoạn lệnh bạn gửi cũng được ghi vào macro.</li>
        <li>Nhấp <b>Dừng ghi</b> và đặt tên để lưu.</li>
        <li>Để phát lại, chọn mục đánh dấu <b>Macro</b> trong danh sách <b>Đoạn lệnh</b> trên thanh công cụ. Các phím đã ghi được gửi theo thứ tự, đúng như khi gõ.</li>
      </ol>
      <ul>
        <li><b>Nhiều thiết bị cùng lúc</b>: Gửi đoạn lệnh hoặc macro khi <b>Nhập đồng thời</b> đang bật ở trên cùng, nội dung cũng tới các tab terminal khác ở cùng loại dòng (shell, câu hỏi đăng nhập, v.v.).</li>
        <li><b>Đừng ghi mật khẩu</b>: Macro lưu phím đúng như khi gõ, nên mật khẩu nhập trong lúc ghi cũng bị lưu.</li>
        <li>Có thể xem nội dung macro trong <b>Quản lý đoạn lệnh…</b> (⏎ = Enter, ⇥ = Tab, ^C = Ctrl+C). Có thể đổi tên và xóa, nhưng không sửa được các phím; hãy ghi lại để thay đổi.</li>
        <li>Đoạn lệnh và macro được lưu trên PC này và dùng chung cho mọi phiên.</li>
      </ul>`,
  },
  {
    id: "ai",
    title: "AI (tạo lệnh · giải thích · trò chuyện · phân tích)",
    icon: "Sparkles",
    body: `
      <p>Kết nối AI trên đám mây (khóa API), CLI theo gói đăng ký hoặc LLM cục bộ trên PC này để hỗ trợ công việc trong terminal. Thêm dịch vụ và chọn AI mặc định trong Cài đặt → AI.</p>
      <ul>
        <li><b>Cách kết nối</b>: khóa API (Anthropic Claude, OpenAI, Google Gemini, máy chủ tương thích OpenAI), CLI theo gói đăng ký (Claude Code, Codex CLI, Gemini CLI: cài trên PC này và đăng nhập một lần, CLI sẽ trả lời bằng gói của bạn), LLM cục bộ (Ollama, hoặc máy chủ tương thích OpenAI như LM Studio, llama.cpp, vLLM). Khóa API được lưu trong kho thông tin xác thực; "Tải danh sách" lấy các mô hình và "Kiểm tra kết nối" thử dịch vụ.</li>
        <li><b>Tạo lệnh</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>): mô tả việc cần làm để nhận một lệnh phù hợp với thiết bị hoặc hệ điều hành đã nhận diện. Nhấn Enter lần nữa để đưa lệnh vào dòng nhập (không chạy); bạn tự chạy bằng Enter. Các quy tắc lệnh nguy hiểm vẫn áp dụng: lệnh bị chặn (đổi giờ, NTP…) thậm chí không được đưa vào dòng nhập.</li>
        <li><b>Giải thích đầu ra</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>): giải thích văn bản đã chọn (hoặc đầu ra gần nhất trên màn hình): ý nghĩa, nguyên nhân có thể và bước tiếp theo.</li>
        <li><b>Trò chuyện AI</b> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>): mở khung hội thoại bên cạnh terminal. "Đính kèm vùng chọn" gửi kèm đầu ra; mỗi dòng lệnh trong câu trả lời có nút đưa nó vào dòng nhập. Kéo cạnh trái của khung để đổi độ rộng (ghi nhớ chung cho mọi tab); nhấp đúp để về độ rộng mặc định. Nội dung trò chuyện có thể kéo chọn để sao chép; mỗi tin nhắn có nút sao chép, cùng với "Sao chép toàn bộ cuộc trò chuyện" ở trên và menu chuột phải.</li>
        <li><b>AI tự chạy lệnh</b>: mô tả việc cần làm trong trò chuyện AI, AI sẽ chạy lần lượt từng lệnh trong terminal này, đọc kết quả và phân tích. Mỗi lần chạy đều hiện trên màn hình và được ghi vào <code>risky-commands.log</code>. Lệnh chỉ đọc (<code>df</code>, <code>free</code>, <code>systemctl status</code>, <code>show …</code>, <code>display …</code>…) chạy ngay; lệnh có thể thay đổi hệ thống sẽ chờ bạn chọn Chạy hoặc Bỏ qua. Lệnh khớp quy tắc chặn (đổi giờ, NTP…) không bao giờ chạy. Tối đa 8 lệnh cho mỗi câu hỏi, mỗi lệnh bị dừng bằng Ctrl+C sau 30 giây. Nút bên dưới khung trò chuyện chuyển sang "hỏi trước mọi lệnh" hoặc "không chạy".</li>
        <li><b>Phân tích cấu hình và log</b>: nút tệp trong khung trò chuyện kiểm tra một cấu hình (vấn đề bảo mật, thiết lập rủi ro) hoặc phân tích một log (lỗi, dấu hiệu bất thường). Với thiết bị mạng, nút thiết bị → "Kiểm tra cấu hình bằng AI" kiểm tra trực tiếp running-config.</li>
        <li><b>Nội dung được gửi</b>: trước khi gửi tới AI trên đám mây, bạn xem chính xác nội dung sẽ gửi và xác nhận ("Không hỏi lại" áp dụng cho cuộc trò chuyện đó). Mật khẩu, khóa và token (<code>password=…</code>, <code>-p…</code>, <code>enable secret</code>, <code>snmp-server community</code>, khóa riêng…) luôn được ẩn; khi bật thiết lập, địa chỉ IP và tên máy chủ cũng được thay bằng IP_1, HOST_1…, rồi hiện lại giá trị thật trong câu trả lời. LLM cục bộ không bao giờ rời khỏi PC này nên không cần xem trước hay ẩn. Hãy kiểm tra chính sách bảo mật của công ty trước khi gửi thông tin thiết bị tới AI bên ngoài.</li>
        <li>CLI theo gói đăng ký: Claude Code chạy với mọi công cụ bị tắt (không chạy lệnh, không đọc tệp) trong một thư mục trống, Codex chạy trong sandbox chỉ đọc. Ứng dụng không bao giờ xử lý thông tin đăng nhập của bạn.</li>
        <li><b>Đính kèm và màn hình từ xa</b>: đính kèm ảnh, PDF và tệp văn bản bằng nút 📎, kéo thả vào khung trò chuyện hoặc <kbd>Ctrl</kbd>+<kbd>V</kbd> (ảnh chụp màn hình). Tệp văn bản được đưa vào tin nhắn và được ẩn thông tin nhạy cảm; ảnh và PDF không thể ẩn nên hiện nguyên trạng trong bản xem trước. Ảnh lớn được thu nhỏ. Hầu hết dịch vụ nhận ảnh; PDF được API Claude, Gemini, OpenAI và Claude Code nhận. Trong RDP và VNC, nút "AI" trên thanh công cụ chụp màn hình từ xa để giải thích hoặc đính kèm vào trò chuyện. AI không chạy lệnh trong màn hình từ xa; hãy sao chép lệnh trong câu trả lời và dán vào màn hình từ xa.</li>
        <li><b>AI trên PC RDP/VNC</b>: chọn "AI" trên thanh công cụ → "Kết nối SSH để AI chạy lệnh…" để xem một dòng lệnh. Trên màn hình từ xa, dán vào Win+R (Run), nhấn Enter và chọn "Có" khi được hỏi quyền quản trị; phần còn lại là tự động. Nếu chưa có OpenSSH, PC này gửi sang PC từ xa để cài (tải một lần từ github.com/PowerShell/Win32-OpenSSH và lưu lại), nên PC Windows 7 không có Internet cũng được. Dịch vụ được khởi động, cổng 22 được cho phép trên mọi cấu hình mạng và PowerShell trở thành shell SSH; tiến trình hiện trong ứng dụng, xong thì một phiên SSH cùng máy chủ, tài khoản và thư mục được mở (phiên đã có sẽ được dùng lại). Nếu PC từ xa không lấy được tệp từ PC này, hãy cho phép BananaConn trong Tường lửa Windows của PC này. Ở đó AI chạy ngay các lệnh PowerShell chỉ đọc như Get-*, ipconfig, systeminfo và hỏi trước với lệnh có thể thay đổi PC. Menu VNC còn có lệnh bật máy chủ SSH trên PC Linux/Unix (mật khẩu VNC không dùng để đăng nhập SSH).</li>
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
        <li><b>So sánh cấu hình</b>: nút thiết bị → "So sánh cấu hình với tệp sao lưu…" đọc cấu hình hiện tại của thiết bị và hiển thị cạnh tệp sao lưu đã chọn trong cửa sổ so sánh (sao lưu trước khi thay đổi để xem thay đổi đã làm gì). Tệp sao lưu được lưu hoặc so sánh gần nhất của mỗi thiết bị sẽ được đưa ra trước (chỉ nhớ trên máy này).</li>
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
        <li><b>Bàn phím</b>: Nhấp vào danh sách một lần, rồi dùng ${kbd("↑")}/${kbd("↓")}, ${kbd("Home")}/${kbd("End")} để chọn mục (${kbd("Shift")} để chọn một dải); ${kbd("Enter")} mở, ${kbd("F2")} đổi tên, ${kbd("Del")} xóa, ${kbd("F5")} làm mới, ${kbd("Backspace")} lên thư mục cha và ${kbd("Ctrl+A")} chọn tất cả. Quay lại hoặc tiến tới giữa các thư mục đã đi qua bằng ${kbd("Alt+←")}/${kbd("Alt+→")}, nút lùi/tiến của chuột hoặc các nút ← và → phía trên đường dẫn.</li>
        <li>Nhấp đúp vào tệp văn bản trên máy chủ để mở trong trình soạn thảo tích hợp; khi lưu, tệp được ghi thẳng lên máy chủ. Nhấp chuột phải vào chỗ trống ở phía máy chủ → "Tệp mới" để tạo tệp trống và sửa ngay (không tạo gì nếu tên đã có).</li>
        <li><b>Quyền</b> (SFTP): nhấp chuột phải vào một mục ở phía máy chủ → "Đổi quyền…" rồi chọn đọc, ghi và thực thi cho chủ sở hữu, nhóm và người khác, hoặc nhập chế độ bát phân (vd: 755). Ba chữ số giữ nguyên các bit setuid, setgid và sticky; bốn chữ số (4755, 0755) đặt cả chúng. Nhiều mục được chọn đều nhận cùng một chế độ; các mục bên trong thư mục không thay đổi. Cột quyền hiển thị các bit đặc biệt như ls (s, t).</li>
        <li><b>Thư mục yêu thích</b>: nút ngôi sao trên thanh đường dẫn phía máy chủ thêm thư mục đang xem vào yêu thích (hoặc bỏ ra) và liệt kê các mục yêu thích để chuyển tới ngay. Chúng được lưu trên PC này theo máy chủ (người dùng, địa chỉ, cổng), nên phiên đã lưu, kết nối nhanh và khung SFTP của tab SSH tới cùng máy chủ dùng chung.</li>
        <li><b>So sánh tệp</b>: nhấp chuột phải vào tệp → "So sánh hai tệp đã chọn" (khi chọn hai tệp trong một khung) để mở cửa sổ so sánh. Với mỗi khung có một tệp (chẳng hạn bản sao lưu cấu hình và cấu hình hiện tại trên máy chủ), chọn "Giữ để so sánh" ở một tệp rồi chọn "So sánh với nội dung đã giữ" ở tệp kia. Cũng có thể so sánh với nội dung đã giữ bằng So sánh vùng chọn trong terminal. Chỉ so sánh tệp văn bản từ 5MB trở xuống.</li>
        <li><b>Chuyển tới thư mục trong terminal</b>: trong khung SFTP mở cạnh một tab SSH, nhấp chuột phải vào thư mục phía máy chủ (hoặc chỗ trống) → "Chuyển tới thư mục này trong terminal (cd)" sẽ gửi <code>cd 'đường dẫn'</code> tới terminal bên cạnh. Chỉ gửi khi đang ở dấu nhắc lệnh và chưa gõ gì, và không bao giờ gửi tới thiết bị không phải shell Linux hoặc Unix.</li>
        <li><b>Đăng nhập bằng khóa</b> (SFTP, giám sát tài nguyên, cổng SSH): với khóa có cụm mật khẩu chưa lưu trong kho, ứng dụng sẽ hỏi cụm mật khẩu và có thể lưu cùng khóa. Cụm mật khẩu chỉ dùng để mở khóa trên PC này, không gửi tới máy chủ. Nếu máy chủ từ chối khóa, ứng dụng hỏi mật khẩu và sau đó đăng nhập bằng mật khẩu đó thay cho khóa.</li>
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
        <li><b>Truyền tệp VNC</b>: bản thân giao thức VNC không có truyền tệp (TightVNC và UltraVNC mỗi bên dùng phần mở rộng riêng). Nút "Truyền tệp" trên thanh công cụ mở khung tệp SFTP tới chính PC đó bên cạnh màn hình. PC từ xa cần máy chủ SSH; nếu đang tắt, tập lệnh trong "AI" → "Kết nối SSH để AI chạy lệnh…" sẽ bật nó.</li>
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
        <li><b>Proxy</b>: Trong mục "Proxy" của trình sửa phiên, chọn SOCKS 4/4a, SOCKS 5, HTTP CONNECT, Telnet (kết nối bằng lệnh) hoặc lệnh cục bộ, giống Connection → Proxy của PuTTY. SSH, SFTP, Telnet, FTP/FTPS, RDP, VNC và trình giám sát tài nguyên của phiên đều đi qua proxy. Chọn thông tin đăng nhập proxy từ kho thông tin xác thực, và đặt các máy chủ không qua proxy (*.corp.local, 10.0.0.0/8), nơi tra cứu tên DNS và việc hiện thông báo chẩn đoán. FTP dùng chế độ thụ động (PASV) khi qua proxy. Phiên nhập từ PuTTY hoặc KiTTY giữ nguyên cài đặt proxy (trừ mật khẩu).</li>
        <li><b>Đường hầm SSH</b>: Công cụ ở trên cùng → Đường hầm SSH. Lưu các chuyển tiếp cổng cục bộ → máy chủ SSH → địa chỉ đích và bật/tắt chúng.</li>
        <li><b>Công cụ mạng</b>: ping, kiểm tra cổng TCP (nhiều cổng và dải cổng), tra cứu DNS, tính subnet (mạng, dải sử dụng được, số host và wildcard mask từ 10.0.0.5/24 hoặc mặt nạ mạng). Khi bật <b>Gửi liên tục</b>, Ping gửi mỗi giây cho đến khi dừng và hiển thị có phản hồi hay không cùng thời gian, tỷ lệ mất, biểu đồ thời gian phản hồi trong hai phút gần nhất và từng lần mất rồi có lại kết nối, kèm âm thanh và thông báo mỗi khi thay đổi (ba lần liên tiếp không phản hồi được coi là mất kết nối). Dùng để theo dõi thiết bị hoạt động trở lại sau khi khởi động lại. Quét IP gửi ping tới mọi địa chỉ của một mạng con (tối đa /22, 1022 host) và liệt kê các thiết bị phản hồi cùng thời gian; "Sao chép địa chỉ không phản hồi" gom các IP có khả năng còn trống (thiết bị có tường lửa chặn ping cũng hiện là không phản hồi). Bấm vào một địa chỉ trong kết quả để ping, kiểm tra cổng, tạo phiên mới hoặc sao chép địa chỉ; cột Tên hiển thị tên thiết bị theo DNS hoặc tệp hosts. Khi quay lại Quét IP từ công cụ khác, kết quả gần nhất sẽ hiện lại. Thiết bị cùng phân đoạn mạng với máy này (không qua router) còn hiển thị địa chỉ MAC, có thể sao chép theo cách viết của Linux, Windows, Cisco hoặc Huawei. Thiết bị trong cùng phân đoạn chặn ping nhưng phản hồi ARP sẽ hiện là "Không phản hồi (thấy qua ARP)" và không nằm trong danh sách địa chỉ không phản hồi.</li>
        <li><b>Truy vết tuyến</b>: "Truy vết tuyến" trong công cụ mạng kiểm tra ba lần mỗi router trên đường tới đích như tracert và lần lượt hiển thị địa chỉ, tên (DNS) và thời gian phản hồi của từng bước nhảy khi nó trả lời. Bước không trả lời hiển thị là * (thường do tường lửa), nhiều địa chỉ ở một bước là đường cân bằng tải. Ô bên cạnh là số bước nhảy tối đa (mặc định 30); việc truy vết kết thúc khi đích trả lời hoặc một router báo không tới được. Nhấp địa chỉ của một bước để Ping, kiểm tra cổng hoặc tạo phiên mới. Không cần quyền quản trị và chỉ hỗ trợ IPv4. Mục "Truy vết tuyến" trong menu của địa chỉ IPv4 trong đầu ra terminal, hoặc của địa chỉ trong kết quả quét IP, sẽ bắt đầu ngay.</li>
        <li><b>Máy chủ tệp</b>: Nút máy chủ tệp ở trên cùng tạm thời chia sẻ một thư mục trên PC này qua FTP, TFTP hoặc HTTP (VD để tải image OS lên thiết bị).</li>
        <li><b>Nhận syslog</b>: bắt đầu từ nút máy chủ tệp ở trên cùng → "Nhận syslog", khi đó thông điệp từ các thiết bị được cấu hình gửi nhật ký tới máy này (ví dụ <code>logging host địa-chỉ-máy-này</code> của Cisco) sẽ hiện ngay khi tới (UDP, cổng mặc định 514). Mỗi thông điệp kèm địa chỉ người gửi và mức độ (emerg đến debug); có thể lọc, chỉ giữ "warning trở lên" v.v., sao chép các dòng đang hiện hoặc lưu vào tệp. Việc nhận vẫn tiếp tục khi đóng cửa sổ; khi đang chạy, thanh trạng thái hiển thị và nhấp vào đó sẽ mở lại. Giữ tối đa 20.000 thông điệp mới nhất. Bấm vào địa chỉ nguồn gửi để chỉ xem thông điệp của thiết bị đó (đúng địa chỉ đó), mở công cụ mạng hoặc tạo phiên mới tới địa chỉ đó. Khi bật "Cảnh báo", thông điệp mức err trở lên (err, crit, alert, emerg) sẽ phát tiếng bíp và làm nhấp nháy thanh tác vụ, kèm thông báo Windows khi ứng dụng không ở phía trước. Tính năng này vẫn hoạt động khi đã đóng cửa sổ; liên kết lên xuống liên tục chỉ được báo tối đa 30 giây một lần, các thông điệp đến trong khoảng đó được gộp theo số lượng. Khi bật "Lưu vào tệp khi nhận", mọi thông điệp, kể cả những thông điệp cửa sổ không hiện được, sẽ được ghi thêm ngay khi nhận vào cuối tệp đã chọn, mỗi thông điệp một dòng (thời gian, người gửi, mức độ, nội dung, cách nhau bằng tab). Nếu không ghi được tệp, chỉ việc lưu dừng lại và bạn sẽ được báo.</li>
      </ul>`,
  },
  {
    id: "security",
    title: "Thông tin đăng nhập · Bảo mật",
    icon: "KeyRound",
    body: `
      <ul>
        <li><b>Kho thông tin đăng nhập</b> (nút chìa khóa ở trên cùng): Lưu mật khẩu và khóa SSH trong Windows Credential Manager để dùng trong trình sửa phiên. Mật khẩu đã lưu không bao giờ được hiển thị ra màn hình. Khóa có thể ở định dạng OpenSSH hoặc PuTTY (.ppk). Kho và trình sửa phiên cảnh báo các tệp khóa không dùng được (không có tệp, định dạng khác, người dùng khác cũng đọc được); <b>Sửa quyền</b> đổi khóa để chỉ người dùng này đọc được. Khi OpenSSH bỏ qua khóa như vậy trong terminal, <b>Sửa quyền tệp khóa</b> trong thông báo sẽ sửa rồi kết nối lại. Chọn một mục trong kho sẽ hiện các phiên đang dùng nó, để biết phiên nào bị ảnh hưởng khi đổi mật khẩu hoặc khóa.</li>
        <li><b>Mật khẩu chính</b> (Cài đặt → Bảo mật): Khóa ứng dụng khi khởi động và sau khi bạn rời đi.</li>
        <li>Khóa máy chủ SSH/SFTP được đối chiếu với <code>~/.ssh/known_hosts</code>; khóa chưa biết sẽ hiển thị dấu vân tay để xác nhận. Khóa đã thay đổi sẽ chặn kết nối. Nếu chắc chắn máy chủ đã được cài lại, nút <b>Xóa khóa đã lưu</b> trong hộp thoại đó sẽ xóa khóa cũ, và lần kết nối tiếp theo hiển thị dấu vân tay mới để bạn kiểm tra và tin cậy (terminal, tệp và cổng SSH).</li>
      </ul>`,
  },
  {
    id: "update",
    title: "Cập nhật",
    icon: "RefreshCw",
    body: `
      <p>Khi khởi động và <b>mỗi 30 phút</b> trong lúc chạy (cả khi bạn quay lại cửa sổ sau một lúc), ứng dụng kiểm tra phiên bản mới trên <b>GitHub</b> (github.com/NijG/bananaconn). Với máy bị chính sách bảo mật chặn GitHub, hãy chỉ định <b>thư mục cập nhật NAS</b> (thư mục chia sẻ chứa các phiên bản mới) trong Cài đặt → Cập nhật; thư mục này được kiểm tra khi không kết nối được GitHub. Khi tìm thấy phiên bản mới, một <b>cửa sổ hỏi có cập nhật ngay không</b> sẽ hiện ra. "Cập nhật ngay" sẽ đóng ứng dụng, cài đặt rồi mở lại (các kết nối đang mở sẽ bị ngắt). Nếu chọn "Để sau", bạn có thể cài bất cứ lúc nào bằng nút <b>Cập nhật</b> bên phải thanh trạng thái. Cửa sổ chọn sẵn "Để sau", nên phím Enter gõ cho terminal không bao giờ bắt đầu cập nhật.</p>
      <p><b>Khi thất bại với lỗi "mật khẩu không đúng"</b>: Windows kết nối tới thư mục chia sẻ bằng tài khoản Windows bạn đang đăng nhập, và không chuyển sang truy cập khách ngay cả khi thư mục chia sẻ cho phép đọc ẩn danh (khách). Hãy mở thư mục cập nhật trong Explorer, nhập tài khoản NAS và đánh dấu "Remember my credentials", hoặc chọn một tài khoản từ kho thông tin đăng nhập trong <b>Tài khoản NAS</b> tại Cài đặt → Cập nhật. Ứng dụng sẽ đăng nhập bằng tài khoản đó. Nếu tài khoản NAS đã chọn bị từ chối, kiểm tra tự động sẽ không đăng nhập lại bằng tài khoản đó (để mật khẩu sai không dồn lại và khóa tài khoản) và Cài đặt sẽ báo điều này; sau khi sửa mật khẩu, "Kiểm tra ngay" sẽ dùng lại.</p>
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
        <tr><td>${kbd("Ctrl+Shift+T")}</td><td>Mở lại tab đã đóng</td></tr>
        <tr><td>Nhấp đúp vào tab</td><td>Mở lại cùng phiên</td></tr>
        <tr><td>${kbd("Ctrl+Shift+F")}</td><td>Tìm trong terminal</td></tr>
        <tr><td>${kbd("Ctrl")}+cuộn chuột</td><td>Cỡ chữ terminal</td></tr>
        <tr><td>${kbd("Ctrl+0")}</td><td>Đặt lại cỡ chữ terminal</td></tr>
        <tr><td>${kbd("Ctrl+Shift+B")}</td><td>Thu gọn thanh bên</td></tr>
        <tr><td colspan="2"><b>Trong danh sách phiên</b></td></tr>
        <tr><td>${kbd("Enter")} / ${kbd("F2")} / ${kbd("Del")}</td><td>Kết nối / Sửa / Xóa (áp dụng cho tất cả khi chọn nhiều mục)</td></tr>
        <tr><td>${kbd("Ctrl+Shift+C")}</td><td>Sao chép địa chỉ (mỗi dòng một địa chỉ khi chọn nhiều mục)</td></tr>
        <tr><td>${kbd("Ctrl+C")} / ${kbd("Ctrl+V")}</td><td>Sao chép / dán phiên</td></tr>
        <tr><td>${kbd("Ctrl")}·${kbd("Shift")}+nhấp, ${kbd("Ctrl+A")}</td><td>Chọn nhiều</td></tr>
      </table>`,
  },
];
