## Company Analysis Skill

这是一个基于《公司分析的思考清单.xlsx》整理出来的公司分析 Skill 包。

### 文件结构

| 文件 | 用途 |
|---|---|
| `SKILL.md` | Skill 主说明，包含触发条件、证据审计规则、完整分析流程和输出要求 |
| `templates/company_analysis_report_template.html` | 完整 HTML 公司分析报告模板 |
| `templates/evidence_matrix_template.md` | 证据审计矩阵模板 |
| `templates/checklist_question_bank.md` | 从 Excel 清单整理出的完整问题库 |
| `templates/scorecard_template.csv` | 评分表模板 |
| `references/company-type-analysis.md` | 公司主类型识别、分析路由、类型化评分权重和估值风险门禁 |
| `references/cyclical-company-analysis.md` | 周期股跨周期校准、单位经济和估值纪律 |

### 使用方式

把整个 `company-analysis-skill` 文件夹放进 Skill 目录；核心文件是 `SKILL.md`。分析会先识别公司的主导价值来源和主类型，再切换问题重点、评分权重、估值方法与风险门禁。最终报告默认输出为专业研报风格的单文件 HTML，并禁止使用 emoji。  
后续当你要求“分析某家公司”“判断某只股票是否值得买”“复盘财报”“解释股价下跌”等任务时，就可以按这个 Skill 的流程执行。
