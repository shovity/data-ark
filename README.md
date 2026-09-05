# data-ark

Cắt file lớn thành từng chunk 1.8GB và lưu trữ trên Telegram, khôi phục lại được nguyên vẹn.

## Dùng ngay

```bash
npx data-ark login                        # chỉ cần một lần
npx data-ark data.tar --to @kho_backup    # đích được ghi nhớ cho lần sau
npx data-ark data.tar                     # từ lần thứ hai trở đi
npx data-ark restore ark-20260905-7f3a91
```

## Cần chuẩn bị

- Node.js 18 trở lên.
- `api_id` và `api_hash` lấy tại <https://my.telegram.org> → API development tools. Lệnh `login` sẽ hỏi hai giá trị này, kèm số điện thoại và mã xác nhận.

data-ark đăng nhập bằng chính tài khoản Telegram của bạn (MTProto), không phải bot. Đây là điều kiện bắt buộc: Bot API chỉ cho upload 50MB mỗi file, còn tài khoản người dùng được 2GB.

## Tuỳ chọn

| Cờ | Mặc định | Ý nghĩa |
|---|---|---|
| `--to <chat>` | đích đã ghi nhớ | `@username`, `-100123…`, hoặc `me` |
| `--chunk-size <n>` | `1800MB` | Ví dụ `1.8GB`, `500MB`. Trần cứng 1950MB. |
| `--concurrency <n>` | `8` | Số phần 512KB gửi song song. Phải là số nguyên từ 1 trở lên. |
| `--out <đường-dẫn>` | basename của tên trong manifest | Nơi ghi file khi restore, tính từ thư mục hiện tại nếu là đường dẫn tương đối |

## Hoạt động thế nào

Mỗi lần chạy sinh ra một `backupId`. File được đọc thẳng theo offset, không tạo file tạm, và đẩy lên thành các document tên `<backupId>.partNNNN`. Xong hết, data-ark gửi thêm một manifest JSON liệt kê message id và sha256 của từng chunk. Restore chỉ cần `backupId`: nó tìm manifest trong chat, tải từng chunk về đúng vị trí trong một file `.partial`, đối chiếu sha256 và kích thước từng chunk, và chỉ đổi tên thành file thật sau khi *toàn bộ* chunk đã khớp.

Đứt mạng giữa chừng lúc **upload** thì cứ chạy lại đúng lệnh cũ — tiến độ nằm ở `~/.data-ark/state/`, những chunk đã xong sẽ được bỏ qua (`backupId` giữ nguyên). Vài lưu ý về việc chạy lại:

- Nếu chạy lại với `--to` khác với đích đã lưu trong tiến độ dở dang, data-ark **từ chối chạy** thay vì tự chuyển hướng — một backup không thể tách làm hai đích. Thông báo lỗi chỉ đường: bỏ `--to` để tiếp tục gửi vào đích cũ, hoặc xoá file trạng thái để bắt đầu backup mới.
- Nếu chạy lại với `--chunk-size` khác, data-ark coi đó là một backup mới hoàn toàn (backup id mới), không resume.

**Restore không có trạng thái để resume.** Nhấn `Ctrl-C` giữa lúc restore thì không có gì được lưu — chạy lại sẽ tải lại từ đầu.

## Giới hạn cần biết

- Chunk không thể vượt 1950MB vì Telegram chỉ nhận 4000 phần 512KB mỗi file.
- Dữ liệu **không** được mã hoá. Đừng đẩy thứ gì bạn không muốn nằm trên hạ tầng của người khác.
- Xoá message chunk trên Telegram là mất backup, không có cách cứu.
- Giữ lấy `backupId`. Không có nó thì phải tự tìm manifest trong chat bằng tay.

## Cấu hình lưu ở đâu

`~/.data-ark/config.json` (quyền 600) chứa `apiId`, `apiHash`, session và đích lưu mặc định. `npx data-ark logout` xoá session và giữ lại phần còn lại.
