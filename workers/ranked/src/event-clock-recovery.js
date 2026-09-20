// Recovery evidence is server-written. Client flags never authorize recovery.
export function matchesClockRejection(inbox, cursor, receipt) {
  const timestamp = inbox?.receivedAt?.__firestoreTimestamp;
  const receivedAt = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  return Number.isSafeInteger(receivedAt) && Number.isSafeInteger(receipt?.updatedAt) && receipt.updatedAt >= 0 &&
    receipt.updatedAt < receivedAt && cursor?.status === 'inbox_receipt_expired' && cursor.runId === null &&
    cursor.attemptId === inbox.attemptId && cursor.receivedAt?.__firestoreTimestamp === timestamp &&
    receipt.status === 'rejected' && receipt.reason === 'inbox_receipt_expired' &&
    receipt.attemptId === inbox.attemptId && receipt.periodId === inbox.periodId &&
    receipt.ownerUid === inbox.ownerUid && receipt.accountId === inbox.accountId && receipt.timeMs === inbox.timeMs;
}
