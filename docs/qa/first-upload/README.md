# گزارش نهایی اصلاح incident اولین آپلود — liara-agent-demo

تاریخ: ۲۲ اکتبر ۲۰۲۶. نتیجهٔ فنی: اصلاح و تست‌های آفلاین آماده‌اند. نتیجهٔ انتشار واقعی: **NO-GO؛ هیچ انتشار یا تلاش مجددی در این بررسی انجام نشد.**

## نتایج اجرا

| بررسی | نتیجه | شاهد |
|---|---|---|
| TypeScript و ESLint | موفق | [check-final.log](check-final.log) |
| تمام تست‌های واحد/یکپارچه | **۱۵۶۵ موفق، ۰ شکست، ۰ skip؛ ۶۳ فایل** | [check-final.log](check-final.log) |
| تمام Playwright | **۱۳۵ موفق، ۰ شکست، ۰ skip، ۰ flaky؛ Chrome، production/mock** | [playwright.log](playwright.log)، [JSON](playwright.json) |
| ساخت production عامل | موفق با `next build --webpack` | [build-webpack-final.log](build-webpack-final.log) |
| ساخت production خود دمو | موفق با `next build --webpack` | [demo-build.log](demo-build.log) |
| پیش‌نمایش واقعی محلی دمو | GET صفحه و `/health` موفق؛ بدون overflow در ۳۶۰، ۷۶۸ و ۱۲۸۰ پیکسل | [demo-preview-check.json](demo-preview-check.json)، [تصویر موبایل](demo-360.png) |
| بررسی ایستای آرشیو | **READY**؛ ۸ فایل، ۰ نام متغیر محیطی اجباری، ۰ فایل حساس | [offline-preview.json](offline-preview.json) |
| امنیت وابستگی‌ها با GET | ۵۳۱ ترکیب نام/نسخه از lockfile عامل و دمو؛ تنها یک advisory توسعه؛ ۰ مورد production در این پایگاه | [dependency-findings.json](dependency-findings.json)، [public-source-review.json](public-source-review.json) |

تست‌ها در کپی مستقل `/tmp/liara-incident-final-ybw0iyi0` اجرا شدند؛ `.env.local` و پایگاه‌دادهٔ واقعی به آن منتقل نشدند. منبع، تست‌ها، اسکریپت‌ها و تنظیمات اصلیِ کپی با پروژهٔ اصلی مقایسه شدند: [۲۸۵ فایل، صفر اختلاف](source-equivalence.json). خروجی ساخت خود دمو در `/tmp/liara-demo-runtime-ybw0iyi0` نگه داشته شد تا fixture منبع تمیز بماند. تغییرات هم‌زمان رابطِ نمایش قفل عملیات قبلی، تأیید محلی abandon و تست‌های آن‌ها نیز به snapshot نهایی منتقل و دوباره بررسی شدند. پورت ۳۱۰۱ توسط فرایند دیگری استفاده می‌شد؛ به آن فرایند دست زده نشد. کپی مستقلی از همان شش فایل E2E با تنها جایگزینی پورت localhost به ۳۱۳۱ استفاده شد: [شرح تغییر محیط تست](e2e-port-adaptation.json). فایل‌های تست پروژهٔ اصلی تغییر نکردند.

ساخت پیش‌فرض Turbopack در sandbox با `binding to a port: Operation not permitted` شکست خورد؛ شکست محیط پنهان نشده و اسکریپت build پروژه تغییر نکرده است. ساخت production با backend رسمی webpack موفق بود. این بررسی ساخت روی زیرساخت واقعی لیارا را تضمین نمی‌کند.

## قرارداد رسمی و sourceID

منابع عمومی رسمی فقط با GET بازخوانی شدند؛ snapshot محلی OpenAPI بایت‌به‌بایت با upstream برابر است:

- [OpenAPI، commit 338325a42cd28d12dcee10c088840d2098504a8b](https://github.com/liara-cloud/openapi/blob/338325a42cd28d12dcee10c088840d2098504a8b/spec/paas.yaml): پاسخ آپلود `sourceID: string` و ورودی انتشار نیز رشته است؛ pattern، format یا حد طول منتشر نشده است.
- [upload.ts در CLI رسمی، commit 14ec35f79d703a09a5e3abbb22ba59239cdde80d](https://github.com/liara-cloud/cli/blob/14ec35f79d703a09a5e3abbb22ba59239cdde80d/src/services/upload.ts): multipart با یک فیلد `file`.
- [deploy.ts در همان CLI](https://github.com/liara-cloud/cli/blob/14ec35f79d703a09a5e3abbb22ba59239cdde80d/src/commands/deploy.ts): خواندن `sourceID` و انتقال آن به JSON درخواست انتشار، بدون اعتبارسنجی قالب.

پارسر اصلاح‌شده شناسه‌های دارای نقطه، اسلش، دونقطه، `+` و `=` را بدون تغییر می‌پذیرد؛ همان قاعده در پاسخ HTTP، درخواست انتشار و schema ذخیره‌سازی SQLite استفاده می‌شود. آزمون ۳۰هزار ورودی، JSON round-trip، چرخهٔ جعلی upload→release و بازخوانی SQLite پاس شدند. در مسیر فعلی، sourceID فقط دادهٔ JSON است؛ در URL، مسیر فایل، دستور shell یا HTML خام قرار نمی‌گیرد. وجود ASCII به‌تنهایی مجوز استفاده در چنین sinkهایی نیست.

**محدودیت صریح:** قاعدهٔ ۱ تا ۲۵۶ کاراکتر ASCII چاپ‌شدنی بدون فاصله، quote و backslash، سیاست دفاعی محلی است؛ لیارا آن را مستند نکرده است. بنابراین پذیرش قالب‌های opaque آزموده‌شده تأیید شده، اما «سازگاری کامل با هر رشتهٔ مجاز OpenAPI» تأیید نشده است. رشتهٔ خارج از این سیاست به `unknown_outcome / malformed_response` و بررسی اپراتور منتهی می‌شود؛ هرگز retry خودکار ندارد. توضیحات کد و نام تست‌ها برای جلوگیری از ادعای سازگاری کامل تصحیح شدند.

پاسخ اصلی incident نگهداری نشده است؛ نمی‌توان ثابت کرد علت واقعی همان محدودیت pattern بوده یا پاسخ خالی/غیرJSON/فاقد شناسه بوده است. اصلاح، یک ناسازگاری اثبات‌شده و شکاف مشاهده‌پذیری را می‌بندد؛ علت دقیق همان پاسخ تاریخی همچنان نامعلوم است.

## diagnostics پاک‌سازی‌شده

شکاف جدیدی در بازبینی نهایی بسته شد: صرفاً حذف کاراکترهای خاص از نام کلید و Content-Type مانع نشت یک رازِ دارای حروف عادی نمی‌شد. اکنون فقط نام‌های شناخته‌شدهٔ پروتکل و media typeهای ثابت نگهداری می‌شوند؛ نام ناشناخته `[other]` و نوع ناشناخته `?` می‌شود. پارامترهای header حذف می‌شوند.

شاهد ذخیره‌شده فقط شامل HTTP status، اندازه، کلاس empty/JSON/non-JSON/too-large، حداکثر ۱۲ کلید مجاز یا ماسک‌شده، نوع/طول/کلاس کلی مقدار و وضعیت حضور sourceID/releaseID است. مقدار شناسهٔ نامعتبر، متن body، پیام upstream، مقدار header و متن HTML ذخیره نمی‌شود. سقف خواندن پاسخ ۶۴ KiB است و پاسخ‌های غیر۲xx قبل از parse دسته‌بندی می‌شوند.

علاوه بر تست‌های empty، HTML، JSON خراب، array، شناسهٔ ناقص و پاسخ بزرگ، سه تست نهایی افزوده شد:

1. راز در نام کلید یا media type، حتی با نویسه‌های مجاز، به نتیجه یا logger نشت نمی‌کند.
2. پاسخ HTTP جعلی ۲۰۱ از write-client تا audit واقعی SQLite منتقل می‌شود؛ status و shape می‌مانند و canary در نتیجه/کل audit غایب است. دقیقاً یک fetch جعلی؛ بدون ساخت برنامه یا نسخه.
3. abandon هم‌زمان فقط یک موفقیت و یک audit دارد؛ پس از بازکردن اتصال جدید SQLite، replay همچنان رد می‌شود.

## رهاکردن و جلوگیری از replay

`resolve("abandon")` فقط compare-and-set رکورد عملیات از `NEEDS_OPERATOR_REVIEW` به `FAILED` با علت `abandoned_by_operator` و ثبت audit محلی است؛ slot برنامهٔ موجود آزاد می‌شود. هیچ فراخوانی write transport، آپلود، ساخت نسخه، حذف، rollback یا تغییر پلن ندارد. ترنسپورتی که با هر تماس تست را خراب می‌کند، برای abandon و restart صفر تماس ثبت کرد. تست reverify نیز هیچ write ندارد، هرچند در اجرای واقعی می‌تواند GET انجام دهد.

پیشنهاد مصرف‌شده دوباره approve/reject/execute نمی‌شود؛ abandon تکراری و reverify پس از terminal شدن رد می‌شوند؛ digest قدیمی پیشنهاد جدید را تأیید نمی‌کند؛ restart هیچ ارسال مجددی شروع نمی‌کند. تست‌ها شامل persistence و رقابت هم‌زمان بودند، نه فقط وضعیت در حافظه.

رکورد واقعی فقط با اتصال SQLite در حالت `mode=ro` و `query_only` خوانده شد: [previous-operation.json](previous-operation.json).

- عملیات `lop_20261022184638_3db4352a`: همچنان **NEEDS_OPERATOR_REVIEW** و فعال؛ `updatedAt` همان `2026-10-22T18:48:18.989Z` است.
- پیشنهاد `lprop_20261022184638_0aead922`: **CONSUMED**؛ sourceId و releaseId ذخیره‌شده ندارد.
- audit همین عملیات یک `upload_attempt` تاریخی و سپس `operation_needs_review` و `operation_reverify` دارد؛ هیچ تلاش انتشار ثبت نشده است. این audit محلی جایگزین بررسی وضعیت سرور لیارا نیست.
- در این بررسی عملیات واقعی abandon یا execute نشد و پایگاه‌دادهٔ واقعی تغییر داده نشد؛ تضمین رفتار abandon با fixture و SQLite موقت آزموده شد.

## پیش‌نمایش تازه و اتصال آرشیو

- [پیش‌نمایش HTML آفلاین](index.html) — فاقد هر نوع دکمهٔ اجرا یا درخواست شبکهٔ خارجی.
- [دموی production محلی](http://127.0.0.1:3125/) و [GET /health](http://127.0.0.1:3125/health).
- [پیش‌نمایش ساختاری JSON](offline-preview.json): `persisted=false`، `executable=false`، `target.checked=false`؛ هیچ proposal/approval زنده‌ای ایجاد نمی‌کند.
- [ZIP بازتولیدشده](liara-agent-demo.zip): ۸۸۰۱ بایت، ۸ فایل.
- [آرشیو source.tar.gz](source.tar.gz): ۸۰۶۷ بایت، ۸ فایل، تولید مجدد بایت‌به‌بایت برابر.

| اتصال | SHA-256 |
|---|---|
| ZIP | `80e5288707b83a3e411ff2ea4d544e4c8cde899727665feaceb4334864f26249` |
| analysis | `fd18e103f1b1056355256225c1c9cf2a9c2d0c81d2f2462d923cac913246b651` |
| tar.gz | `a26e1dde0009df7cdf8003680f7ef24a234448b9ac73eca8d7cce4eef6fbaf81` |

هر سه digest با پیشنهاد incident برابرند. بسته‌بندی بدون نصب/اجرای کد آپلودی انجام شد؛ ساخت محلی فقط روی fixture مورد اعتماد خود مخزن صورت گرفت. سلامت محلی پاسخ `{"status":"ok","app":"liara-agent-demo","version":"1"}` داشت. این نتیجه اثبات سلامت مقصد واقعی نیست.

## امنیت و موانع باقی‌مانده

1. **تنظیم واقعی live روشن مشاهده شد.** فایل `.env.local` در جریان بررسی توسط این کار تغییر نکرد. بررسی آفلاین تنظیمات، `LIARA_LIVE_DEPLOY_ENABLED=true`، CLI خاموش، contract attestation تنظیم‌شده، suffix برابر `liara.run`، مسیر `/health` و marker مشخص را نشان داد: [actual-settings-offline.log](actual-settings-offline.log). تمام اجراهای این بررسی صریحاً در محیط جداگانه با live=false، mock/disabled AI، بدون توکن واقعی و بدون env واقعی بودند. این گزارش هیچ مجوزی برای استفاده از پرچم اصلی نمی‌دهد.
2. عملیات قدیمی هنوز محلی حل نشده و slot را نگه داشته است. بازاجرا ممنوع و در کد مسدود است؛ این بررسی آن را رها نکرد.
3. هویت فعلی برنامه، network، release baseline و سلامت مقصد زنده تازه بررسی نشده‌اند. هیچ GET به API حساب لیارا در این بررسی ارسال نشد. پیش‌نمایش آفلاین نمی‌تواند جای این شواهد را بگیرد؛ تأیید تازه‌ای هم صادر نشده است.
4. محدودیت محلی parser از قرارداد رسمی رشته باریک‌تر است؛ پاسخ incident برای تعیین قالب واقعی قابل بازیابی نیست.
5. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): **high**، `braces@3.0.3` در زنجیرهٔ dev مربوط به lint، بدون نسخهٔ اصلاح‌شده در advisory رسمی در زمان بررسی. در production tree عامل یا دمو مورد منطبق دیگری در GitHub Reviewed npm Advisories پیدا نشد. نبود advisory تضمین امنیت کلی نیست.
6. `npm audit` آنلاین اجرا نشد چون درخواست POST به registry می‌فرستد. اجرای `--offline` روی cache خالی ظاهراً خروجی صفر می‌دهد و **به‌عنوان اسکن معتبر استفاده نشد**. بررسی تازهٔ جایگزین با endpoint رسمی GET GitHub انجام شد: ۱۶ GET، ۵۳۱ ترکیب دقیق نام/نسخه، pagination کامل؛ این نتیجه صراحتاً خروجی آنلاین npm audit نیست. نوع reviewed بررسی شد، نه پایگاه malware یا unreviewed.
7. ساخت پیش‌فرض Turbopack در این محیط محدود هنوز قابل تأیید نیست؛ backend webpack و اجرای production محلی موفق‌اند. Chrome بررسی شده است؛ ادعای پوشش Firefox، Safari یا زیرساخت production لیارا نمی‌شود.

## محدودهٔ مجاز رعایت‌شده

هیچ retry آپلود، POST زنده، فعال‌سازی استقرار، اجرای CLI لیارا، BoxAPI، درخواست LLM پولی، commit یا push انجام نشد. POSTهای Playwright فقط مربوط به login و گردش‌کار سرور mock محلی بودند. همهٔ تست‌های واحد/یکپارچه محافظ شبکه دارند؛ ساخت، E2E Node و پیش‌نمایش نیز محافظ خروجی داشتند؛ لاگ محافظ هیچ تلاش خروجی بیرونی ثبت نکرد. تنها شبکهٔ عمومیِ عمدی، خواندن منابع رسمی و advisoryهای عمومی با GET بود.

فرمان‌های اصلیِ اجراشده در کپی موقت، با محیط پاک و live=false:

```sh
npm run check
npm run build -- --webpack
node_modules/.bin/playwright test -c /tmp/liara-e2e-isolated-ybw0iyi0/playwright.offline.config.ts
node --import tsx scripts/make-demo-zip.ts
node --conditions=react-server --import tsx verification/offline-preview.ts
python3 verification/verify-public-get.py
```

خود دمو جداگانه با `next build --webpack` ساخته شد. نسخهٔ متنی فایل‌های تنظیم و اسکریپت‌های QA این پوشه برای بازبینی نگهداری شده‌اند؛ اجرای خودکار هیچ‌کدام بخشی از startup برنامه نیست. برای تکرار، مسیرهای موقت و پورت‌ها باید به پوشهٔ مستقل همان بررسی اشاره کنند و env واقعی نباید بارگذاری شود.
