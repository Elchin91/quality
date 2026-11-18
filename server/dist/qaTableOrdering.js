/** SQL fragments are defined by the calling endpoint. Request values can only select a key. */
export function tableOrderBy(order, columns, defaultOrder, stableKey) {
    if (!order.sort_by)
        return defaultOrder;
    if (!Object.hasOwn(columns, order.sort_by) ||
        (order.sort_direction !== undefined && order.sort_direction !== 'asc' && order.sort_direction !== 'desc')) {
        throw new Error('Invalid table order');
    }
    const direction = order.sort_direction === 'desc' ? 'DESC' : 'ASC';
    return `${columns[order.sort_by]} ${direction} NULLS LAST, ${stableKey}`;
}
