# ClearPane 阅读与评论

这是一个脱敏验收文件。选中这段文字，点击“评论”，输入意见，再发送到专用测试会话。

这一段用于测试跨段选择。调整字号和行高后，阅读位置应继续保持在文档附近。

## 表格与任务

| 功能 | 状态 | 说明 |
| --- | --- | --- |
| 手动刷新 | 待验收 | 同长度覆盖也必须重新读 |
| 选区评论 | 待验收 | 引用来自可见文本 |

- [x] 只读任务复选框
- [ ] 不写回文件

## 代码

```javascript
const message = 'ClearPane';
console.log(message);
```

```unknown-language
这是未知语言，按普通代码显示。
<script>不会执行</script>
```

## 图表

```mermaid
flowchart LR
  A[打开文件] --> B[阅读]
  B --> C[选区评论]
  C --> D[主会话]
```

## 公式

行内公式 $E = mc^2$。

$$
\frac{1}{2} + \frac{1}{3} = \frac{5}{6}
$$

无效公式只在本处提示 $\badcommand$。

## 资源与安全

![占位图片](https://example.invalid/not-loaded.png)

[外链仅复制](https://example.com)

[危险地址](javascript:alert(1))

<script>globalThis.clearPaneUnsafe = true</script>

正文仍应可读。文件版本 B。
