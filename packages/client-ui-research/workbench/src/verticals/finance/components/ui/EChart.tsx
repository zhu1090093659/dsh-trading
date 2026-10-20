import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart, BarChart, HeatmapChart, CandlestickChart } from "echarts/charts";
import {
  GridComponent, TooltipComponent, LegendComponent, MarkLineComponent,
  VisualMapContinuousComponent, DataZoomInsideComponent, DataZoomSliderComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

// 按需注册：全量 echarts 约 1MB，这里只打包用到的折线 / 柱状 / 热力图 / K 线与基础组件。
// 热力图要配连续型 visualMap；长序列（回测净值、K 线）要配缩放条。
echarts.use([
  LineChart, BarChart, HeatmapChart, CandlestickChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent,
  VisualMapContinuousComponent, DataZoomInsideComponent, DataZoomSliderComponent, CanvasRenderer,
]);

interface Props {
  option: echarts.EChartsCoreOption;
  height?: number;
}

// 轻量 ECharts 容器：初始化 / 跟随窗口 resize / 卸载时 dispose。
// 主题策略：容器本身不感知亮暗色。调用方要么在 option 里用两种模式都可读的颜色，
// 要么像回测图表那样读 CSS 颜色令牌、主题切换时重算 option。
export function EChart({ option, height = 300 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current);
    // ResizeObserver 而非 window.resize：侧栏收起/展开改变容器宽度时
    // 并不触发窗口 resize 事件，只监听 window 会让图表保持旧尺寸被裁切
    const ro = new ResizeObserver(() => inst.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      inst.current?.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    // notMerge=true：整份替换，避免旧 series 残留（刷新后型号增减时）
    // 配置有误时 ECharts 会同步抛错；在 effect 里不接住会让 React 卸掉整页，只剩一片空白
    try {
      inst.current?.setOption(option, true);
      setFailed(false);
    } catch (e) {
      console.error("图表渲染失败", e);
      setFailed(true);
    }
  }, [option]);

  return (
    <div className="relative" style={{ height }}>
      <div ref={ref} style={{ height }} />
      {failed && <p className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">这张图没有画出来，数据见报告正文</p>}
    </div>
  );
}
