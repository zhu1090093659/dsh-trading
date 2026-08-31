/**
 * KnowledgeGraph.tsx — force-graph 原生 Canvas 包装组件（对齐 TvChart.tsx 先例）。
 *
 * 规格：
 *   1. 节点颜色 = 主题簇（tags[0]），中性色板；
 *   2. 节点大小 = 基于 degree 的自适应半径；
 *   3. Hover 交互 = 聚焦当前节点及其一阶邻域（其余节点与边半透明淡化）；
 *   4. Click 交互 = 选中节点触发抽屉；
 *   5. 支持 ref 暴露 focusNode(nodeId) 居中放大动画。
 */
import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import ForceGraph, { type ForceGraphInstance } from 'force-graph'
import type { KnowledgeCard, KnowledgeGraphData, KnowledgeGraphNode, KnowledgeGraphLink } from '@dsh-trading/knowledge'

// 中性柔和主题色板（避免使用涨跌红绿色）
const CLUSTER_COLORS = [
  '#3b82f6', // 蓝
  '#10b981', // 绿
  '#8b5cf6', // 紫
  '#f59e0b', // 琥珀黄
  '#ec4899', // 粉
  '#06b6d4', // 青
  '#6366f1', // 靛青
  '#14b8a6', // 蓝绿
  '#f97316', // 橙
  '#64748b', // 蓝灰
]

function getClusterColor(cluster: string): string {
  let hash = 0
  for (let i = 0; i < cluster.length; i++) {
    hash = (hash << 5) - hash + cluster.charCodeAt(i)
    hash |= 0
  }
  const index = Math.abs(hash) % CLUSTER_COLORS.length
  return CLUSTER_COLORS[index] ?? '#64748b'
}

export interface KnowledgeGraphHandle {
  focusNode(nodeId: string): void
}

export interface KnowledgeGraphProps {
  data: KnowledgeGraphData
  selectedCardId?: string
  onSelectCard: (card: KnowledgeCard) => void
}

export const KnowledgeGraph = forwardRef<KnowledgeGraphHandle, KnowledgeGraphProps>(function KnowledgeGraph(
  { data, selectedCardId, onSelectCard },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphInstanceRef = useRef<ForceGraphInstance | null>(null)

  // 当前 hover 与高亮集合
  const hoverNodeRef = useRef<KnowledgeGraphNode | null>(null)
  const highlightNodesRef = useRef<Set<string>>(new Set())
  const highlightLinksRef = useRef<Set<string>>(new Set())

  // 暴露外部定位聚焦命令
  useImperativeHandle(ref, () => ({
    focusNode(nodeId: string) {
      if (!graphInstanceRef.current) return
      const graphData = graphInstanceRef.current.graphData()
      const targetNode = graphData.nodes.find((n: any) => n.id === nodeId) as any
      if (targetNode && typeof targetNode.x === 'number' && typeof targetNode.y === 'number') {
        graphInstanceRef.current.centerAt(targetNode.x, targetNode.y, 800)
        graphInstanceRef.current.zoom(2.5, 800)
      }
    },
  }))

  useEffect(() => {
    if (!containerRef.current) return

    const container = containerRef.current
    const width = container.clientWidth || 600
    const height = container.clientHeight || 400

    // 初始化 ForceGraph
    const graph = new (ForceGraph as any)(container)
      .width(width)
      .height(height)
      .backgroundColor('transparent')
      .nodeId('id')
      .nodeVal((node: KnowledgeGraphNode) => Math.max(3, Math.min(16, 3 + Math.sqrt(node.degree) * 2.5)))
      .nodeColor((node: KnowledgeGraphNode) => getClusterColor(node.cluster))
      .linkColor((link: any) => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source
        const targetId = typeof link.target === 'object' ? link.target.id : link.target
        const linkKey = `${sourceId}__${targetId}`

        if (highlightNodesRef.current.size > 0) {
          return highlightLinksRef.current.has(linkKey) ? 'rgba(59, 130, 246, 0.8)' : 'rgba(200, 205, 215, 0.1)'
        }
        return link.kind === 'related' ? 'rgba(59, 130, 246, 0.45)' : 'rgba(160, 170, 185, 0.25)'
      })
      .linkWidth((link: any) => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source
        const targetId = typeof link.target === 'object' ? link.target.id : link.target
        const linkKey = `${sourceId}__${targetId}`

        if (highlightLinksRef.current.has(linkKey)) {
          return link.kind === 'related' ? 3 : 2
        }
        return link.kind === 'related' ? 1.8 : 1
      })
      .nodeLabel((node: KnowledgeGraphNode) => {
        const raw = node.raw
        if (!raw) return node.label
        return `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; padding: 6px 10px; background: rgba(26, 30, 36, 0.92); color: #ffffff; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 260px; pointer-events: none;">
            <div style="font-weight: 600; margin-bottom: 4px; color: #60a5fa;">${node.label}</div>
            <div style="color: #cbd5e1; line-height: 1.4; margin-bottom: 4px;">${raw.summary}</div>
            <div style="color: #94a3b8; font-size: 10px;">${raw.source.author} · ${raw.tags.join(', ')}</div>
          </div>
        `
      })
      .onNodeHover((node: KnowledgeGraphNode | null) => {
        hoverNodeRef.current = node
        highlightNodesRef.current.clear()
        highlightLinksRef.current.clear()

        if (node) {
          highlightNodesRef.current.add(node.id)
          const currentLinks = graph.graphData().links
          for (const l of currentLinks) {
            const sId = typeof l.source === 'object' ? l.source.id : l.source
            const tId = typeof l.target === 'object' ? l.target.id : l.target
            if (sId === node.id || tId === node.id) {
              highlightNodesRef.current.add(sId)
              highlightNodesRef.current.add(tId)
              highlightLinksRef.current.add(`${sId}__${tId}`)
              highlightLinksRef.current.add(`${tId}__${sId}`)
            }
          }
        }
        graph.nodeColor(graph.nodeColor()).linkColor(graph.linkColor())
      })
      .onNodeClick((node: KnowledgeGraphNode) => {
        if (node.raw) {
          onSelectCard(node.raw)
        }
      })
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const radius = Math.max(3, Math.min(14, 3 + Math.sqrt(node.degree ?? 0) * 2))
        const isHovered = hoverNodeRef.current?.id === node.id
        const isSelected = selectedCardId === node.id
        const isHighlighted = highlightNodesRef.current.has(node.id)
        const hasActiveHover = highlightNodesRef.current.size > 0

        ctx.save()

        // 透明度淡化
        if (hasActiveHover && !isHighlighted && !isSelected) {
          ctx.globalAlpha = 0.18
        }

        const color = getClusterColor(node.cluster ?? '未分类')

        // 绘制外圈高亮光晕
        if (isHovered || isSelected) {
          ctx.beginPath()
          ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI, false)
          ctx.fillStyle = isSelected ? 'rgba(59, 130, 246, 0.3)' : 'rgba(59, 130, 246, 0.2)'
          ctx.fill()
          ctx.lineWidth = 1.5
          ctx.strokeStyle = '#3b82f6'
          ctx.stroke()
        }

        // 绘制主节点圆
        ctx.beginPath()
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false)
        ctx.fillStyle = color
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()

        // 当放大到一定比例或处于高亮态时，在节点下方绘制文本 Label
        if (globalScale > 1.2 || isHovered || isSelected || isHighlighted) {
          const label = node.label || ''
          const fontSize = Math.max(9, Math.min(13, 11 / globalScale))
          ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'

          // 背景描边提升文字在深/浅背景下的可读性
          ctx.lineWidth = 2.5
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
          ctx.strokeText(label, node.x, node.y + radius + 2)
          ctx.fillStyle = '#1a1e24'
          ctx.fillText(label, node.x, node.y + radius + 2)
        }

        ctx.restore()
      })

    // 载入数据
    const graphDataFormatted = {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    }
    graph.graphData(graphDataFormatted)

    graphInstanceRef.current = graph

    // 自适应 Resize
    const handleResize = () => {
      if (containerRef.current && graphInstanceRef.current) {
        graphInstanceRef.current.width(containerRef.current.clientWidth)
        graphInstanceRef.current.height(containerRef.current.clientHeight)
      }
    }

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      if (graphInstanceRef.current) {
        graphInstanceRef.current._destructor?.()
        graphInstanceRef.current = null
      }
    }
  }, [data, onSelectCard, selectedCardId])

  return <div ref={containerRef} className="dshtrading-knowledge-graph-canvas" style={{ width: '100%', height: '100%' }} />
})
