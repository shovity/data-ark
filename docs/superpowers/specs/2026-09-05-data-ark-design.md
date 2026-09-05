# data-ark — Thiết kế

Ngày: 2026-09-05
Trạng thái: đã chốt, chờ lập kế hoạch triển khai

## 1. Mục tiêu

Một CLI phát hành dưới dạng npm package, chạy bằng `npx data-ark data.tar`, tự
động cắt file lớn thành các chunk 1.8GB và đẩy lên Telegram, đồng thời khôi phục
lại được file gốc nguyên vẹn từ Telegram.

Tiêu chí thành công:

- Upload một file 50GB lên Telegram và restore lại được, sha256 từng chunk khớp.
- Người dùng chỉ phải cấu hình đúng một lần, sau đó lệnh upload không cần tham số.
- Mất kết nối giữa chừng thì chạy lại lệnh cũ là đi tiếp, không upload lại từ đầu.

Ngoài phạm vi v1: nén, mã hóa, lệnh liệt kê các backup đã có, xóa backup từ xa,
đồng bộ thư mục, upload nhiều file trong một lệnh.

## 2. Quyết định nền tảng

**Dùng tài khoản người dùng qua MTProto (GramJS), không dùng Bot API.** Bot API
tiêu chuẩn giới hạn upload 50MB; muốn bot đẩy file lớn phải tự dựng Local Bot API
Server. Tài khoản người dùng cho trần 2GB mỗi file (4GB với Premium), là điều kiện
cần để chunk 1.8GB tồn tại, và giữ được lời hứa "cài xong là chạy".

**Chunk 1.8GB.** MTProto giới hạn 4000 part mỗi file, mỗi part tối đa 512KB, tức
trần cứng 2000MB. 1.8GB ứng với 3686 part, còn biên an toàn. `--chunk-size` bị
chặn không cho vượt 1950MB, và thông báo lỗi phải giải thích lý do.

**Đọc thẳng từ file gốc, không tạo file tạm.** Uploader tự gọi
`upload.saveBigFilePart` và đọc từng part 512KB từ file gốc theo offset. Không tốn
đĩa tạm, không tốn RAM.

**Song song ở tầng part, tuần tự ở tầng chunk.** Tốc độ thực tế của MTProto đến từ
việc bắn nhiều part 512KB cùng lúc trong một file, chứ không phải chạy nhiều chunk
1.8GB song song. Cách này cho băng thông tương đương mà tiến độ vẫn là một thanh
tuyến tính dễ hiểu, resume sạch (chunk hoặc xong hoặc chưa), và ít nguy cơ
`FLOOD_WAIT` hơn. Mặc định 8 part, chỉnh bằng `--concurrency`.

**Mỗi backup tự chứa một manifest trên Telegram.** Không có index tập trung. Xóa
một backup không ảnh hưởng backup khác, và không có state chung nào để hỏng. Máy
mất sạch vẫn restore được chỉ từ `backupId`.

## 3. Bề mặt CLI

```bash
npx data-ark login                        # đăng nhập tương tác, chạy một lần
npx data-ark data.tar                     # upload
npx data-ark data.tar --to @kho_backup    # upload và ghi nhớ đích cho lần sau
npx data-ark restore ark-20260905-7f3a91
npx data-ark logout                       # xóa session
```

Tham số đầu tiên nếu không trùng `login` / `restore` / `logout` thì được coi là
đường dẫn file cần upload. Nhờ vậy `npx data-ark data.tar` chạy đúng như trực giác
mà vẫn còn chỗ cho subcommand. File không tồn tại thì báo lỗi rõ ràng, không được
báo "unknown command".

| Cờ | Mặc định | Ý nghĩa |
|---|---|---|
| `--to <chat>` | đích đã ghi nhớ trong config | `@username`, `-100123…`, hoặc `me` |
| `--chunk-size <n>` | `1800MB` | Chấp nhận `1800MB`, `1.8GB`, hoặc số byte |
| `--concurrency <n>` | `8` | Số part 512KB bay song song |
| `--out <path>` | tên file trong manifest | Chỉ dùng cho `restore` |

Không dùng biến môi trường. Toàn bộ cấu hình nằm ở `~/.data-ark/config.json`,
`chmod 600`, chứa `apiId`, `apiHash`, `session`, `defaultChat`.

`--to` khi được truyền sẽ ghi đè `defaultChat` trong config, nên lần sau chỉ cần
`npx data-ark data.tar`. Cuối luồng `login` hỏi thêm một câu "Đẩy vào chat nào?",
Enter để bỏ qua. Chạy upload khi chưa từng có đích nào thì báo
`Chưa có đích lưu — chạy lại với --to @kho_backup`, không được đoán mò.

Phụ thuộc runtime duy nhất là `telegram` (GramJS). Parse tham số dùng `node:util`
`parseArgs`, hỏi đáp dùng `node:readline/promises`, thanh tiến độ tự vẽ bằng `\r`.
Node >= 18, ESM.

## 4. Cấu trúc module

```
bin/data-ark.js        shebang, gọi src/cli.js
src/cli.js             parseArgs + định tuyến 4 lệnh
src/config.js          đọc/ghi ~/.data-ark/config.json (chmod 600)
src/client.js          dựng TelegramClient, luồng login tương tác
src/uploader.js        đẩy dải byte [offset, offset+len) của một fd → message id
src/downloader.js      tải document theo message id → ghi vào offset của file đích
src/manifest.js        tạo / parse / tìm manifest trên Telegram
src/state.js           lưu & đọc tiến độ resume
src/progress.js        thanh tiến độ một dòng
src/commands/{upload,restore,login,logout}.js
```

Ranh giới quan trọng nhất là `uploader.js`. Nó không biết gì về backup, chunk hay
manifest. Hợp đồng của nó: *cho một file descriptor, một offset, một độ dài, một
cái tên — trả về message id và sha256 của dải byte đó*. Nhờ vậy nó test được độc
lập bằng file vài KB, và toàn bộ phần rối rắm của MTProto bị nhốt trong một chỗ.

`downloader.js` đối xứng: *cho một message id và một offset trong file đích — ghi
nội dung document vào đúng đó, trả về sha256 đã tính khi ghi*.

## 5. Luồng dữ liệu

### Upload

1. Nạp config, kết nối, phân giải chat đích. Nếu có `--to` thì ghi lại vào config.
2. `stat` file, tính `soChunk = ceil(size / chunkSize)`.
3. Tra state theo khóa `sha1(đường-dẫn-tuyệt-đối:size:mtimeMs)`. Có thì lấy lại
   `backupId` và danh sách chunk đã xong; không thì sinh `backupId` mới dạng
   `ark-YYYYMMDD-<6 hex ngẫu nhiên>`.
4. Với từng chunk chưa xong, tuần tự:
   - Sinh `fileId` ngẫu nhiên 64-bit.
   - Chia chunk thành các part 512KB, `fs.read` thẳng từ file gốc theo offset.
   - Bắn 8 part song song qua `upload.saveBigFilePart`, vừa đọc vừa cập nhật
     sha256 của chunk.
   - Xong thì `messages.sendMedia` với `InputMediaUploadedDocument` bọc
     `InputFileBig`, đặt tên `ark-20260905-7f3a91.part0001`, caption
     `#dataark ark-20260905-7f3a91 1/42`.
   - Ghi message id, size, sha256 vào state rồi `fsync` ngay.
5. Hết chunk thì dựng manifest và gửi lên như một document nhỏ tên
   `ark-20260905-7f3a91.manifest.json`, caption
   `#dataark ark-20260905-7f3a91 manifest`.
6. Xóa state, in ra dòng lệnh restore để người dùng cất giữ.

### Restore

1. Kết nối, phân giải chat từ config.
2. `messages.search` trong chat theo `backupId`, lọc lấy document có tên kết thúc
   bằng `.manifest.json`, tải về bộ nhớ và parse.
3. Xác định đường dẫn đích (`--out` hoặc `name` trong manifest). Nếu file đã tồn
   tại thì hỏi xác nhận ghi đè.
4. Cấp phát trước file `<đích>.partial` đúng `size` trong manifest.
5. Với từng chunk theo thứ tự: `messages.getMessages` theo `msgId`, tải và ghi vào
   đúng offset `i * chunkSize`, đối chiếu sha256.
6. Mọi chunk verify xong mới `rename` `.partial` thành file thật.

Vì ghi theo offset nên restore cũng có thể resume trong tương lai mà không phải
đổi kiến trúc.

## 6. Định dạng manifest

```json
{
  "v": 1,
  "id": "ark-20260905-7f3a91",
  "name": "data.tar",
  "size": 75161927680,
  "chunkSize": 1887436800,
  "createdAt": "2026-09-05T07:40:12.000Z",
  "chunks": [
    { "i": 0, "msgId": 1234, "size": 1887436800, "sha256": "a3f1…" },
    { "i": 1, "msgId": 1235, "size": 1887436800, "sha256": "9c20…" }
  ]
}
```

Cố ý không có sha256 của toàn file: tính nó đòi đọc thêm một lượt qua hàng chục GB
chỉ để lấy một con số, trong khi hash từng chunk cộng với đủ số chunk và khớp tổng
size đã đủ phát hiện mọi hỏng hóc thực tế. File 1TB thì manifest cũng chỉ khoảng
60KB.

## 7. State resume

Đường dẫn: `~/.data-ark/state/<sha1(đường-dẫn-tuyệt-đối:size:mtimeMs)>.json`

```json
{
  "id": "ark-20260905-7f3a91",
  "chat": "@kho_backup",
  "path": "/home/shovity/data.tar",
  "size": 75161927680,
  "mtimeMs": 1757000000000,
  "chunkSize": 1887436800,
  "done": {
    "0": { "msgId": 1234, "size": 1887436800, "sha256": "a3f1…" }
  }
}
```

File gốc bị sửa thì `size` hoặc `mtimeMs` đổi, khóa đổi theo, và lần chạy sau là
một backup mới — đúng ngữ nghĩa. Mỗi lần ghi state đều theo kiểu ghi ra `.tmp` rồi
`rename`, để state không bao giờ rách nửa chừng.

## 8. Xử lý lỗi

Nguyên tắc xuyên suốt: không bao giờ tạo ra dữ liệu sai một cách im lặng.

- `FLOOD_WAIT_x` dưới 60s để GramJS tự ngủ; trên 60s thì in đếm ngược rõ ràng chứ
  không treo câm.
- Mỗi part thất bại thử lại tối đa 5 lần với backoff lũy thừa. Hết lượt thì hỏng
  cả chunk, thoát mã 1, state còn nguyên, chạy lại lệnh cũ là đi tiếp.
- `SIGINT`: ghi state, đóng client sạch, thoát 130. Không bỏ lại một nửa upload
  không dấu vết.
- Restore gặp message chunk đã bị xóa: dừng ngay và nói rõ thiếu chunk số mấy.
  Chỉ đổi tên `.partial` thành file thật khi mọi chunk đã verify xong.
- sha256 lệch: báo lỗi, giữ nguyên `.partial` để điều tra.
- Session hết hạn: báo `Phiên đăng nhập đã hết hạn, chạy npx data-ark login`.

## 9. Kiểm thử

Làm theo TDD, viết test trước.

**Unit.** Chia chunk ở các biên hiểm: file nhỏ hơn một chunk, chia hết chằn chặn,
dư đúng 1 byte. Parse `1.8GB` / `1800MB` / số byte, và từ chối giá trị vượt
1950MB. Serialize–parse manifest khứ hồi. Logic resume bỏ đúng những chunk đã có
trong `done`. Định tuyến CLI phân biệt được subcommand với đường dẫn file.

**Integration với Telegram giả.** Đây là test đáng giá nhất. Thay lớp `invoke`
bằng bản giả, rồi khẳng định `uploader` gửi đúng số part, đúng `fileTotalParts`,
đọc đúng offset, và ghép lại các part nhận được thì ra đúng dải byte gốc. Chạy
được trong CI, không cần tài khoản thật.

**End-to-end thật.** Một kịch bản thủ công có tài liệu: file 100MB với
`--chunk-size 10MB`, upload rồi restore rồi so sánh sha256 hai file. Không đưa vào
CI vì cần credential thật.

## 10. Rủi ro đã biết

Rủi ro về API song song ở tầng part đã được kiểm tra trực tiếp trong source
`telegram@2.26.22` và hoá ra nhỏ hơn dự kiến. `client/uploads.js` upload file lớn
bằng cách gọi `Api.upload.SaveBigFilePart` nhiều lần với cùng một `fileId`, gom
thành từng lô rồi `Promise.all` — không có API đặc biệt nào cần mượn.
`Utils.getAppropriatedPartSize` trả về đúng 512KB cho mọi file trên 750MB, và
`_fileToMedia` chấp nhận `Api.InputFileBig` đã upload sẵn, nên `client.sendFile`
dùng lại được handle mà uploader trả về.

Điều còn lại chưa xác minh: `client.invoke()` có thực sự bắn song song hay xếp
hàng tuần tự. Nếu đo được tốc độ không tăng khi nâng `--concurrency`, đường lui là
đổi sang đúng cách GramJS tự dùng — `client.getSender(client.session.dcId)` rồi
`sender.send(request)` — mà không phải đụng tới phần còn lại của kiến trúc.

Tên `data-ark` trên npm registry hiện trả về 404, tức chưa có ai lấy.
