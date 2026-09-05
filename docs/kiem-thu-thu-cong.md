# Kiểm thử đầu-cuối bằng tài khoản thật

Bộ test tự động dùng client giả nên không chạm vào Telegram. Trước khi phát hành,
chạy tay kịch bản này một lần.

## Chuẩn bị

```bash
npm install
npm test                        # phải xanh hết
node bin/data-ark.js login      # dùng tài khoản thật
```

Tạo một channel riêng để thử, ví dụ `@kho_thu_nghiem`.

## Kịch bản

```bash
# 1. Dựng file 100MB ngẫu nhiên
head -c 104857600 /dev/urandom > /tmp/thu.bin
sha256sum /tmp/thu.bin | tee /tmp/thu.sha

# 2. Upload với chunk nhỏ để có nhiều chunk
node bin/data-ark.js /tmp/thu.bin --to @kho_thu_nghiem --chunk-size 12MB
# Ghi lại backup id hiện ra ở dòng cuối.

# 3. Restore ra chỗ khác
node bin/data-ark.js restore <backup-id> --out /tmp/thu-lai.bin

# 4. Đối chiếu
sha256sum /tmp/thu-lai.bin
diff <(cut -d' ' -f1 /tmp/thu.sha) <(sha256sum /tmp/thu-lai.bin | cut -d' ' -f1) && echo "KHỚP"
```

File 100MB chia theo `--chunk-size 12MB` (12582912 byte) ra 9 chunk: 8 chunk
đầu đúng 12582912 byte, **vượt** ngưỡng 10MB nên đi nhánh big-file
(`SaveBigFilePart` / `InputFileBig` / `sendFile` nhận `InputFileBig`); chunk
thứ 9 là phần dư 4194304 byte (4MB), dưới ngưỡng nên vẫn đi nhánh nhỏ
(`SaveFilePart` / `InputFile`). Đây là kịch bản duy nhất trong cả bài kiểm thử
thủ công chạm nhánh big-file — cũng chính là nhánh mà **mọi** lần backup dùng
chunk-size mặc định (1800MB) sẽ đi qua, nên bắt buộc phải xanh ở lần chạy tay
này.

## Cần quan sát thêm

- **Resume:** chạy lại bước 2, nhấn `Ctrl-C` giữa chừng, rồi chạy lại đúng lệnh đó.
  Phải thấy các dòng `Chunk N/9 đã có, bỏ qua.` và backup id không đổi. Thông báo
  sau `Ctrl-C` phải nói tiến độ đã được lưu.
- **Đổi đích khi resume:** ngay sau khi `Ctrl-C` ở bước trên, chạy lại lệnh cũ nhưng
  đổi `--to` sang một chat khác. Phải bị từ chối với thông báo giải thích không thể
  tách một backup ra hai đích, kèm hướng dẫn bỏ `--to` hoặc xoá file trạng thái.
- **Thiếu chunk:** xoá một message chunk trên Telegram rồi restore. Phải báo đúng
  `Thiếu chunk N/9` và không tạo ra file kết quả (file `.partial` vẫn còn để kiểm tra).
- **Ghi đè:** restore hai lần vào cùng `--out`. Lần hai phải hỏi xác nhận.
- **Ctrl-C khi restore:** nhấn `Ctrl-C` giữa lúc restore đang tải chunk. Thông báo
  phải nói rõ chưa lưu gì, chạy lại sẽ tải lại từ đầu — khác với upload.
- **Chưa có đích:** đổi tên `~/.data-ark/config.json` thành bản sao, xoá
  `defaultChat`, rồi chạy upload không kèm `--to`. Phải thấy thông báo có chữ `--to`.

## Hai trường hợp quanh ngưỡng 10MB

Telegram tách hai API upload: từ trên 10MB mới được dùng nhóm "big", dưới ngưỡng
đó phải dùng `upload.saveFilePart`. Bộ test tự động chỉ kiểm được request nào
được phát ra, còn việc máy chủ có nhận hay không thì phải thử thật. Cả hai kịch
bản A và B dưới đây đều **dưới** ngưỡng nên chỉ chạm nhánh nhỏ
(`SaveFilePart` / `InputFile`) — nhánh big-file đã được kịch bản chính ở trên
phủ rồi, hai kịch bản này chỉ để phủ nốt phía bên kia ngưỡng.

```bash
# A. File nhỏ hơn 10MB — cả file nằm gọn trong một chunk dưới ngưỡng
head -c 5242880 /dev/urandom > /tmp/thu-nho.bin        # 5MB
sha256sum /tmp/thu-nho.bin
node bin/data-ark.js /tmp/thu-nho.bin --to @kho_thu_nghiem
node bin/data-ark.js restore <backup-id> --out /tmp/thu-nho-lai.bin
sha256sum /tmp/thu-nho-lai.bin                          # phải khớp

# B. File đúng chunkSize + 1 byte — chunk cuối chỉ có 1 byte
head -c 10485761 /dev/urandom > /tmp/thu-du1.bin        # 10MB + 1
sha256sum /tmp/thu-du1.bin
node bin/data-ark.js /tmp/thu-du1.bin --to @kho_thu_nghiem --chunk-size 10MB
node bin/data-ark.js restore <backup-id> --out /tmp/thu-du1-lai.bin
sha256sum /tmp/thu-du1-lai.bin                          # phải khớp
```

Cả hai phải chạy trót lọt, không có lỗi kiểu `FILE_PARTS_INVALID` hay
`FILE_PART_SIZE_INVALID`, và restore phải cho ra đúng sha256 ban đầu. Ở kịch bản
B, chunk thứ hai đúng 1 byte — đây là chunk nhỏ nhất mà data-ark có thể sinh ra.
