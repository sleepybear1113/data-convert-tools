# 测试样本

这里只放脱敏、最小化、允许提交的测试样本。

- `dbf/`：已脱敏的 JavaDBF 基准样本、全部指定类型的最小二进制夹具和对应预期值 JSON。
- `csv/`：引号、内嵌换行、UTF-8、GBK、前导零等边界样本。
- `xlsx/`：多工作表、日期、空值和公式缓存值样本。
- `sqlite/`：最小单表和多表数据库。

当前已有 `dbf/vfp-0x30-c-nulls.dbf` 及对应头部预期值 JSON，以及 `csv/people.csv`、`xlsx/people.xlsx`。DBF 来自用户确认已脱敏的样本，CSV/XLSX 为合成测试数据。

不要复制尚未脱敏的业务数据到这里。自动化测试不应只依赖本机被 Git 忽略的 `sample-data/`，否则换机或 CI 无法运行。
