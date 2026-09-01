/**
 * KnowledgeGraph.tsx — force-graph 原生 Canvas 包装组件（对齐 TvChart.tsx 先例）。
 *
 * 2026-09-01 Obsidian 化改造（参考 Obsidian graph view 体验）：
 *   1. 数据层切 tagHubs 模式：卡片节点 + 标签 hub 节点，无全配对边；
 *   2. 力学：高阻尼（velocityDecay 0.45）+ alphaDecay 0.028 快收敛 + 碰撞斥力，
 *      布局收敛后自动 zoomToFit——打开即是稳定可读状态，不抖不飘；
 *   3. 标签策略：卡片标签放大到阈值或 hover 才显示（Obsidian 同款），
 *      标签 hub 常显（#名），避免 215 个标签糊成一片；
 *   4. 节点视觉：卡片=实心圆（主题簇色），hub=空心环（灰蓝），一眼可分。
 *
 * 既有规格：hover 一阶邻域聚焦、click 选中抽屉、focusNode 居中放大。
 */
import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react'
import ForceGraph, { type ForceGraphInstance } from 'force-graph'
import type { KnowledgeCard, KnowledgeGraphData, KnowledgeGraphNode, KnowledgeGraphLink } from '@dsh-trading/knowledge'

// 中性柔和主题色板（避免使用涨跌红绿色）
const CLUSTER_COLORS = [
  '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899',
  '#06b6d4', '#6366f1', '#14b8a6', '#f97316', '#64748b',
]

const TAG_HUB_COLOR = '#7c8aa0'

function getClusterColor(cluster: string): string {
  let hash = 0
  for (let i = 0; i < cluster.length; i++) {
    hash = (hash << 5) - hash + cluster.charCodeAt(0) * 31 + cluster.charCodeAt(i)
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
  /** 点击标签 hub 节点（Obsidian 式：点标签=过滤该标签）。 */
  onTagClick?: (tag: string) => void
}

export const KnowledgeGraph = forwardRef<KnowledgeGraphHandle, KnowledgeGraphProps>(function KnowledgeGraph(
  { data, selectedCardId, onSelectCard, onTagClick },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphInstanceRef = useRef<ForceGraphInstance | null>(null)

  // 回调 ref 化：避免内联函数作为 effect 依赖导致实例每帧重建（见 KnowledgeView 先例）。
  const onSelectCardRef = useRef(onSelectCard)
  onSelectCardRef.current = onSelectCard
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick
  const selectedCardIdRef = useRef(selectedCardId)
  selectedCardIdRef.current = selectedCardId

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

    const isTagHub = (node: any) => node?.type === 'tag'

    // 节点半径：卡片按度数自适应；hub 固定小半径（视觉层级低于卡片）
    const nodeRadius = (node: any) => {
      if (isTagHub(node)) return Math.min(9, 3.5 + Math.sqrt(node.degree ?? 0) * 0.8)
      return Math.max(3, Math.min(13, 3 + Math.sqrt(node.degree ?? 0) * 2))
    }

    // 初始化 ForceGraph
    const graph = new (ForceGraph as any)(container)
      .width(width)
      .height(height)
      .backgroundColor('transparent')
      .nodeId('id')
      .minZoom(0.15)
      .maxZoom(10)
      // Obsidian 手感：高阻尼 + 快收敛，打开即基本稳定
      .d3VelocityDecay(0.45)
      .d3AlphaDecay(0.028)
      .d3AlphaMin(0.002)
      .nodeVal((node: KnowledgeGraphNode) => nodeRadius(node) ** 2)
      .nodeColor((node: KnowledgeGraphNode) => (isTagHub(node) ? TAG_HUB_COLOR : getClusterColor(node.cluster)))
      .linkColor((link: any) => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source
        const targetId = typeof link.target === 'object' ? link.target.id : link.target
        const linkKey = `${sourceId}__${targetId}`

        if (highlightNodesRef.current.size > 0) {
          return highlightLinksRef.current.has(linkKey) ? 'rgba(59, 130, 246, 0.75)' : 'rgba(200, 205, 215, 0.06)'
        }
        return link.kind === 'related' ? 'rgba(59, 130, 246, 0.5)' : 'rgba(160, 170, 185, 0.18)'
      })
      .linkWidth((link: any) => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source
        const targetId = typeof link.target === 'object' ? link.target.id : link.target
        const linkKey = `${sourceId}__${targetId}`

        if (highlightLinksRef.current.has(linkKey)) {
          return link.kind === 'related' ? 3 : 2
        }
        return link.kind === 'related' ? 1.8 : 0.7
      })
      .nodeLabel((node: KnowledgeGraphNode) => {
        if (isTagHub(node)) return '#' + node.label
        const raw = node.raw
        if (!raw) return node.label
        return `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 11px; padding: 6px 10px; background: rgba(26, 30, 36, 0.92); color: #ffffff; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); max-width: 260px; pointer-events: none;">
            <div style="font-weight: 600; margin-bottom: 4px; color: #60a5fa;">${'$'}{node.label}</div>
            <div style="color: #cbd5e1; line-height: 1.4; margin-bottom: 4px;">${'$'}{raw.summary}</div>
            <div style="color: #94a3b8; font-size: 10px;">${'$'}{raw.source.author} · ${'$'}{raw.tags.join(', ')}</div>
          </div>`
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
        if (isTagHub(node)) {
          onTagClickRef.current?.(node.label)
          return
        }
        if (node.raw) {
          onSelectCardRef.current(node.raw)
        }
      })
      .nodeCanvasObject((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const radius = nodeRadius(node)
        const isHovered = hoverNodeRef.current?.id === node.id
        const isSelected = !isTagHub(node) && selectedCardIdRef.current === node.id
        const isHighlighted = highlightNodesRef.current.has(node.id)
        const hasActiveHover = highlightNodesRef.current.size > 0
        const hub = isTagHub(node)

        ctx.save()

        // 透明度淡化
        if (hasActiveHover && !isHighlighted && !isSelected) {
          ctx.globalAlpha = 0.15
        }

        const color = hub ? TAG_HUB_COLOR : getClusterColor(node.cluster ?? '未分类')

        if (hub) {
          // 标签 hub：空心环（与卡片实心圆形成视觉层级）
          ctx.beginPath()
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false)
          ctx.fillStyle = 'rgba(250, 250, 252, 0.9)'
          ctx.fill()
          ctx.lineWidth = Math.max(1.2, radius / 3)
          ctx.strokeStyle = color
          ctx.stroke()
        } else {
          // hover/选中光晕
          if (isHovered || isSelected) {
            ctx.beginPath()
            ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI, false)
            ctx.fillStyle = isSelected ? 'rgba(59, 130, 246, 0.3)' : 'rgba(59, 130, 246, 0.2)'
            ctx.fill()
            ctx.lineWidth = 1.5
            ctx.strokeStyle = '#3b82f6'
            ctx.stroke()
          }

          // 主节点圆
          ctx.beginPath()
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false)
          ctx.fillStyle = color
          ctx.fill()
          ctx.lineWidth = 1
          ctx.strokeStyle = '#ffffff'
          ctx.stroke()
        }

        // 标签策略（Obsidian 式）：hub 常显；卡片标签仅放大或 hover/选中时显示
        const showLabel = hub || globalScale > 1.6 || isHovered || isSelected || (isHighlighted && hasActiveHover)
        if (showLabel) {
          const label = hub ? '#' + (node.label || '') : node.label || ''
          const fontSize = hub ? Math.max(10, 12 / globalScale) : Math.max(8, Math.min(13, 11 / globalScale))
          ctx.font = `${'$'}{hub ? 600 : 400} ${'$'}{fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          const ty = hub ? node.y + radius + 2 : node.y + radius + 2
          ctx.lineWidth = 2.5
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
          ctx.strokeText(label, node.x, ty)
          ctx.fillStyle = hub ? '#475569' : '#1a1e24'
          ctx.fillText(label, node.x, ty)
        }

        ctx.restore()
      })
    // 自定义碰撞斥力：force-graph 未内建 collide，用轻量 O(n²) 实现
    // （225 节点 ≈ 2.5 万次比较/tick，可忽略），防止节点重叠成团。
    const collideForce = (alpha: number) => {
      const nodes = graph.graphData().nodes as any[]
      const radii = nodes.map((n) => nodeRadius(n) + 2.5)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        if (typeof a.x !== 'number' || typeof a.y !== 'number') continue
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          if (typeof b.x !== 'number' || typeof b.y !== 'number') continue
          let dx = a.x - b.x
          let dy = a.y - b.y
          let dist = Math.sqrt(dx * dx + dy * dy) || 0.01
          const minDist = radii[i] + radii[j]
          if (dist < minDist && dist > 0) {
            const push = ((minDist - dist) / dist) * alpha * 0.6
            dx *= push
            dy *= push
            const massA = isTagHub(a) ? 0.6 : 1
            const massB = isTagHub(b) ? 0.6 : 1
            a.x += dx * massA;
            a.y += dy * massA;
            b.x -= dx * massB;
            b.y -= dy * massB;
          }
        }
      }
    }
    collideForce["initialize"] = (ns: any[]) => { void ns }
    graph.d3Force('collide', collideForce)

    // 斥力与连线距离按 hub 拓扑调优：hub 间互斥更强，卡-标签连线给足距离，
    // 形成主题簇自然分瓣（Obsidian 观感）。
    const charge = graph.d3Force('charge')
    if (charge) charge.strength(-90).distanceMax(420)
    const linkForce = graph.d3Force('link')
    if (linkForce) {
      linkForce.distance((link: any) => (link.kind === 'related' ? 60 : 78)).strength((link: any) => (link.kind === 'related' ? 0.7 : 0.35))
    }

    // 载入数据
    const graphDataFormatted = {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    }
    graph.graphData(graphDataFormatted)

    // 收敛后自动取景：打开即全览（Obsidian 行为）
    let didFit = false
    graph.onEngineStop(() => {
      if (!didFit) {
        didFit = true
        graphInstanceRef.current?.zoomToFit(500, 60)
      }
    })

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
  }, [data])

  return <div ref={containerRef} className="dshtrading-knowledge-graph-canvas" style={{ width: '100%', height: '100%' }} />
})