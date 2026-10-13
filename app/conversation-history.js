(function exposeConversationHistory(globalScope, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalScope.ConversationHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  const SCHEMA_VERSION = 1;

  function fallbackId() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
  }

  function uniqueIds(ids, nodes) {
    return [...new Set(Array.isArray(ids) ? ids : [])].filter(id => !!nodes[id]);
  }

  function selectedOrNewest(selectedId, childIds) {
    return childIds.includes(selectedId) ? selectedId : childIds.at(-1) || null;
  }

  function createLinearHistory(messages, createId) {
    const graph = {
      schemaVersion: SCHEMA_VERSION,
      rootChildIds: [],
      rootSelectedChildId: null,
      nodes: {}
    };
    let parentId = null;
    for (const message of Array.isArray(messages) ? messages : []) {
      const nodeId = createId();
      const node = {
        ...message,
        nodeId,
        parentId,
        childIds: [],
        selectedChildId: null
      };
      graph.nodes[nodeId] = node;
      if (parentId) {
        graph.nodes[parentId].childIds.push(nodeId);
        graph.nodes[parentId].selectedChildId = nodeId;
      } else {
        graph.rootChildIds.push(nodeId);
        graph.rootSelectedChildId = nodeId;
      }
      parentId = nodeId;
    }
    return graph;
  }

  function repairGraph(graph) {
    const nodes = graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : {};
    graph.nodes = nodes;
    graph.schemaVersion = SCHEMA_VERSION;

    for (const [nodeId, node] of Object.entries(nodes)) {
      node.nodeId = nodeId;
      node.parentId = node.parentId && nodes[node.parentId] ? node.parentId : null;
      node.childIds = uniqueIds(node.childIds, nodes)
        .filter(childId => nodes[childId].parentId === nodeId);
    }

    for (const [nodeId, node] of Object.entries(nodes)) {
      if (node.parentId && !nodes[node.parentId].childIds.includes(nodeId)) {
        nodes[node.parentId].childIds.push(nodeId);
      }
    }

    const rootCandidates = Object.values(nodes)
      .filter(node => !node.parentId)
      .map(node => node.nodeId);
    graph.rootChildIds = uniqueIds(graph.rootChildIds, nodes)
      .filter(nodeId => !nodes[nodeId].parentId);
    for (const nodeId of rootCandidates) {
      if (!graph.rootChildIds.includes(nodeId)) graph.rootChildIds.push(nodeId);
    }

    graph.rootSelectedChildId = selectedOrNewest(
      graph.rootSelectedChildId,
      graph.rootChildIds
    );
    for (const node of Object.values(nodes)) {
      node.selectedChildId = selectedOrNewest(node.selectedChildId, node.childIds);
    }
  }

  function rebuild(chat) {
    const graph = chat.history;
    if (!graph) {
      chat.messages ||= [];
      return chat.messages;
    }
    repairGraph(graph);
    const messages = [];
    const seen = new Set();
    let nodeId = graph.rootSelectedChildId;
    while (nodeId && graph.nodes[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = graph.nodes[nodeId];
      messages.push(node);
      nodeId = node.selectedChildId;
    }
    chat.messages = messages;
    return messages;
  }

  function normalize(chat, createId = fallbackId) {
    const hasGraph = !!(
      chat.history &&
      chat.history.schemaVersion === SCHEMA_VERSION &&
      chat.history.nodes &&
      typeof chat.history.nodes === 'object'
    );
    if (!hasGraph) chat.history = createLinearHistory(chat.messages, createId);
    rebuild(chat);
    return { chat, migrated: !hasGraph };
  }

  function newNodeId(graph, createId) {
    let nodeId = createId();
    while (graph.nodes[nodeId]) nodeId = createId();
    return nodeId;
  }

  function append(chat, message, parentId, createId = fallbackId) {
    normalize(chat, createId);
    const graph = chat.history;
    const resolvedParentId = parentId === undefined
      ? chat.messages.at(-1)?.nodeId || null
      : parentId;
    if (resolvedParentId && !graph.nodes[resolvedParentId]) {
      throw new Error(`Conversation parent does not exist: ${resolvedParentId}`);
    }

    const nodeId = newNodeId(graph, createId);
    const node = {
      ...message,
      nodeId,
      parentId: resolvedParentId,
      childIds: [],
      selectedChildId: null
    };
    graph.nodes[nodeId] = node;
    if (resolvedParentId) {
      const parent = graph.nodes[resolvedParentId];
      parent.childIds.push(nodeId);
      parent.selectedChildId = nodeId;
    } else {
      graph.rootChildIds.push(nodeId);
      graph.rootSelectedChildId = nodeId;
    }
    rebuild(chat);
    return node;
  }

  function node(chat, nodeId) {
    return chat.history?.nodes?.[nodeId] || null;
  }

  function versionInfo(chat, nodeId) {
    normalize(chat);
    const current = node(chat, nodeId);
    if (!current) return { nodeIds: [], index: -1, count: 0 };
    const nodeIds = current.parentId
      ? chat.history.nodes[current.parentId].childIds
      : chat.history.rootChildIds;
    const index = nodeIds.indexOf(nodeId);
    return { nodeIds: [...nodeIds], index, count: nodeIds.length };
  }

  function selectSibling(chat, nodeId, delta) {
    const info = versionInfo(chat, nodeId);
    const targetIndex = Math.max(0, Math.min(info.count - 1, info.index + delta));
    const targetId = info.nodeIds[targetIndex];
    if (!targetId || targetId === nodeId) return { ...info, changed: false, nodeId };
    const current = node(chat, nodeId);
    if (current.parentId) {
      chat.history.nodes[current.parentId].selectedChildId = targetId;
    } else {
      chat.history.rootSelectedChildId = targetId;
    }
    rebuild(chat);
    return {
      nodeIds: info.nodeIds,
      index: targetIndex,
      count: info.count,
      changed: true,
      nodeId: targetId
    };
  }

  function allMessages(chat) {
    normalize(chat);
    return Object.values(chat.history.nodes);
  }

  function forStorage(chat) {
    normalize(chat);
    const messages = chat.messages.map(message => {
      const {
        nodeId,
        parentId,
        childIds,
        selectedChildId,
        ...legacyMessage
      } = message;
      return legacyMessage;
    });
    return { ...chat, messages };
  }

  return {
    SCHEMA_VERSION,
    normalize,
    rebuild,
    append,
    node,
    versionInfo,
    selectSibling,
    allMessages,
    forStorage
  };
});
