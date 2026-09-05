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
node bin/data-ark.js /tmp/thu.bin --to @kho_thu_nghiem --chunk-size 10MB
# Ghi lại backup id hiện ra ở dòng cuối.

# 3. Restore ra chỗ khác
node bin/data-ark.js restore <backup-id> --out /tmp/thu-lai.bin

# 4. Đối chiếu
sha256sum /tmp/thu-lai.bin
diff <(cut -d' ' -f1 /tmp/thu.sha) <(sha256sum /tmp/thu-lai.bin | cut -d' ' -f1) && echo "KHỚP"
```

## Cần quan sát thêm

- **Resume:** chạy lại bước 2, nhấn `Ctrl-C` giữa chừng, rồi chạy lại đúng lệnh đó.
  Phải thấy các dòng `Chunk N/10 đã có, bỏ qua.` và backup id không đổi. Thông báo
  sau `Ctrl-C` phải nói tiến độ đã được lưu.
- **Đổi đích khi resume:** ngay sau khi `Ctrl-C` ở bước trên, chạy lại lệnh cũ nhưng
  đổi `--to` sang một chat khác. Phải bị từ chối với thông báo giải thích không thể
  tách một backup ra hai đích, kèm hướng dẫn bỏ `--to` hoặc xoá file trạng thái.
- **Thiếu chunk:** xoá một message chunk trên Telegram rồi restore. Phải báo đúng
  `Thiếu chunk N/10` và không tạo ra file kết quả (file `.partial` vẫn còn để kiểm tra).
- **Ghi đè:** restore hai lần vào cùng `--out`. Lần hai phải hỏi xác nhận.
- **Ctrl-C khi restore:** nhấn `Ctrl-C` giữa lúc restore đang tải chunk. Thông báo
  phải nói rõ chưa lưu gì, chạy lại sẽ tải lại từ đầu — khác với upload.
- **Chưa có đích:** đổi tên `~/.data-ark/config.json` thành bản sao, xoá
  `defaultChat`, rồi chạy upload không kèm `--to`. Phải thấy thông báo có chữ `--to`.
