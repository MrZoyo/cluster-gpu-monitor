// 国际化管理器
window.I18n = {
  locale: 'zh',

  dict: {
    zh: {
      // 导航与面包屑
      'overview': '总览',
      'user_ranking': '用户排行',
      'back_to_overview': '‹ 返回总览',
      'back_to': '‹ 返回 {name}',

      // 顶栏控件
      'appearance': '外观：',
      'time_window': '时间窗：',
      'theme_dark': '夜间',
      'theme_light': '日间',
      'loading': '加载中…',
      'service_unreachable': '服务不可达',

      // 状态文字
      'online': '在线',
      'offline': '离线',
      'offline_n_times': '离线 {n} 次',
      'planned': '待接入',
      'idle': '空闲',
      'held': '空占',
      'active': '在用',
      'in_use': '在用',

      // KPI 指标
      'instant_util': '瞬时利用率',
      'window_avg': '{window} 平均',
      'accumulating': '积累中',
      'gpu_busy_discovered': 'GPU 在用 / 已发现',
      'coverage_hint': '接入覆盖 {discovered} / {expected}',
      'online_hosts': '在线主机',
      'planned_hosts': '待接入主机',
      'clusters': '集群',
      'hosts': '主机',
      'gpus': 'GPU',
      'current_avg': '当前均值',
      'avg': '均值',

      // 时间相关
      'updated_at': '更新于 {time}',
      'refresh_every': '每 {seconds} 秒刷新',
      'never': '从未',
      'ago_seconds': '{n} 秒前',
      'ago_minutes': '{n} 分钟前',
      'ago_hours': '{n} 小时前',
      'ago_days': '{n} 天前',
      'data_at': '数据 {time}',

      // 警报面板
      'offline_active_hosts': '离线已接入主机',
      'full_load_gpus': '满载 GPU',
      'planned_clusters': '待接入集群',
      'no_realtime_data': '暂无实时 GPU 数据',

      // 利用率图例
      'utilization_pct': '利用率 %',
      'expand_collapse': '展开 / 收起',

      // 主机行
      'host_system_info': 'CPU {cpu} · load {load} · 内存 {mem_used}/{mem_total}',
      'host_planned_info': '{gpu_model} · 规划 {count} 卡',
      'no_system_data': '无系统数据',
      'cards_seen': '{seen}/{expected} 卡',

      // 集群视图
      'cluster_index_machines': '{n} 集群 · {m} 卡',
      'view_cluster_detail': '查看 {name} 详情页（各主机卡阵 · 利用率时序 · 使用人 Top）',

      // 算力域
      'capacity_metrics_clusters': '集群',
      'capacity_metrics_hosts': '主机',
      'capacity_metrics_gpus': 'GPU',
      'capacity_metrics_avg': '当前均值',
      'no_devices': '暂无设备',
      'cluster_column': '集群',
      'status': '状态',

      // 多窗口对比表
      'compare_table_title': '各主机平均利用率 · 多时间窗对比',

      // 错误与空状态
      'load_failed': '加载失败',
      'empty_state': '暂无设备',

      // 健康状态
      'health_online': '在线 {online}/{total} · 数据 {time}',
      'health_host_online': '在线',
      'health_host_offline': '离线',
      'health_cards': '{seen}/{expected}卡',
    },

    en: {
      // Navigation & Breadcrumb
      'overview': 'Overview',
      'user_ranking': 'User Ranking',
      'back_to_overview': '‹ Back to Overview',
      'back_to': '‹ Back to {name}',

      // Topbar Controls
      'appearance': 'Theme:',
      'time_window': 'Window:',
      'theme_dark': 'Dark',
      'theme_light': 'Light',
      'loading': 'Loading…',
      'service_unreachable': 'Service Unreachable',

      // Status
      'online': 'Online',
      'offline': 'Offline',
      'offline_n_times': 'Offline ({n} fails)',
      'planned': 'Planned',
      'idle': 'Idle',
      'held': 'Held',
      'active': 'Active',
      'in_use': 'In Use',

      // KPI Metrics
      'instant_util': 'Instant Util',
      'window_avg': '{window} Avg',
      'accumulating': 'Accumulating',
      'gpu_busy_discovered': 'GPU Busy / Discovered',
      'coverage_hint': 'Coverage {discovered} / {expected}',
      'online_hosts': 'Online Hosts',
      'planned_hosts': 'Planned Hosts',
      'clusters': 'Clusters',
      'hosts': 'Hosts',
      'gpus': 'GPUs',
      'current_avg': 'Current Avg',
      'avg': 'Avg',

      // Time Related
      'updated_at': 'Updated {time}',
      'refresh_every': 'Refresh every {seconds}s',
      'never': 'Never',
      'ago_seconds': '{n}s ago',
      'ago_minutes': '{n}m ago',
      'ago_hours': '{n}h ago',
      'ago_days': '{n}d ago',
      'data_at': 'Data {time}',

      // Alert Panel
      'offline_active_hosts': 'Offline Active Hosts',
      'full_load_gpus': 'Full Load GPUs',
      'planned_clusters': 'Planned Clusters',
      'no_realtime_data': 'No Realtime GPU Data',

      // Utilization Legend
      'utilization_pct': 'Utilization %',
      'expand_collapse': 'Expand / Collapse',

      // Host Row
      'host_system_info': 'CPU {cpu} · load {load} · Memory {mem_used}/{mem_total}',
      'host_planned_info': '{gpu_model} · Planned {count} cards',
      'no_system_data': 'No System Data',
      'cards_seen': '{seen}/{expected} cards',

      // Cluster View
      'cluster_index_machines': '{n} clusters · {m} cards',
      'view_cluster_detail': 'View {name} details (host arrays · utilization trends · top users)',

      // Capacity Domain
      'capacity_metrics_clusters': 'Clusters',
      'capacity_metrics_hosts': 'Hosts',
      'capacity_metrics_gpus': 'GPUs',
      'capacity_metrics_avg': 'Current Avg',
      'no_devices': 'No Devices',
      'cluster_column': 'Cluster',
      'status': 'Status',

      // Compare Table
      'compare_table_title': 'Host Avg Util · Multi-Window Comparison',

      // Error & Empty State
      'load_failed': 'Load Failed',
      'empty_state': 'No Devices',

      // Health Status
      'health_online': 'Online {online}/{total} · Data {time}',
      'health_host_online': 'online',
      'health_host_offline': 'offline',
      'health_cards': '{seen}/{expected} cards',
    }
  },

  t(key, params) {
    const text = this.dict[this.locale][key] || key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
  },

  getLocale() {
    return this.locale;
  },

  setLocale(locale) {
    this.locale = locale;
    localStorage.setItem('gpumon.locale', locale);
    // 触发重新渲染
    if (window.GM && GM.render) {
      GM.render();
    }
  },

  init() {
    const saved = localStorage.getItem('gpumon.locale');
    this.locale = (saved === 'en') ? 'en' : 'zh';
  }
};
