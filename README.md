# 航班运行监控页

导入航班计划、实际起降、机尾号与已确认的联程关系，按机场与日期查看延误；点击某个航班可看到前序飞机与受影响的后续航段。纯静态页面，无构建步骤。

## 运行

```bash
# 任选其一启动静态服务
python3 -m http.server 8000
npx serve .
```

浏览器打开 `http://localhost:8000`，点击「载入示例数据」，或逐个导入自己的 CSV。

## 测试

```bash
node tests/core.test.mjs    # 核心逻辑：时区/跨午夜/换机/延误拆分/联程/情景推算（43 项）
node tests/ui.smoke.mjs     # 页面流程冒烟（需 jsdom：cd /tmp/jsdom-test && npm install jsdom --no-save）
```

## 数据格式（CSV，首行表头）

**机场/时区** `airports.csv`：`code,name,timezone,min_turnaround_min,min_connection_min`
时区为 IANA 名称；`min_turnaround_min` 为该机位最小周转，`min_connection_min` 为最短衔接时间（MCT）。

**航班计划** `plan.csv`：`flight,date,dep,arr,sched_dep,sched_arr,tail,status`
`date` 与时刻均为出发地当地日期/时间；到达时刻早于出发时刻时自动按跨午夜顺延（可跨时区，内部统一换算 UTC 比较）。`status` 取 `SCHEDULED` / `CANCELLED`。

**实际起降** `actuals.csv`：`flight,date,actual_dep,actual_arr,tail`
字段可留空。`tail` 为真实机尾号——换机后飞机链按真实机尾号重新关联。缺实际到达时刻的航段延误记为**未知**，不按准点处理；到达早于起飞等时间矛盾的航段在异常面板单独列出。

**联程关系**（可一次导入多份）：`group,from_flight,to_flight,date,to_date,passengers`
`date`/`to_date` 为前/后段出发地当地日期（`to_date` 可空，自动匹配前段到达后最近一班）。同一旅客组出现在多份关联表中只计一次人数。

## 延误口径

- 飞机链按同一真实机尾号的实际航段顺序排列，周转时间 = 本段实际起飞 − 前段实际到达。
- 离港延误拆分为：**带入** = 前段实际到达晚到、扣除该机场最小周转后仍挤压本段计划起飞的部分；**新增** = 其余部分（当日首段全部为新增）。前段实际到达缺失时拆分结果显示「未知」。

## 情景推算

在航段详情中可：① 把本段起飞时间调整 ±N 分钟；② 修改该出港机场的最小周转要求。系统沿飞机链**向后**计算受影响范围并联动重估联程风险；有实际记录的航段保持实际值，推算值在页面以「推算」标注，可一键清除。结果只回溯到具体航段链条，不做自动改签。

## 示例数据覆盖的场景（samples/）

| 场景 | 航段 | 说明 |
|---|---|---|
| 换机 | CA102/CA103 | 计划机尾 B-1001，实际由 B-2002 执飞，链条按真实机尾重新关联 |
| 取消 | CA1599 | 无实际记录，旅客组 G1 联程断裂 |
| 跨时区/跨午夜 | CA201/CA202（PEK↔SVO）、CA301（PEK→HNL） | 到达落次日或跨日期变更线，统一按 UTC 计算 |
| 错失衔接 | G5（CA501→CA1600）、G2（CA501→CA502） | 可用衔接为负或低于 MCT；G2 在两份关联表中出现，人数只计一次 |
| 时间矛盾 | CA900 | 实际到达早于实际起飞，单独列出 |
| 缺实际到达 | CA901 | 延误未知，不按准点处理 |
