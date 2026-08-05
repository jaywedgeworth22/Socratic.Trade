import { getTradierGateway } from "../src/lib/tradier";
import { getDb, getConnectedAccount } from "../src/lib/db";
import type { EquityOrderInput } from "../src/lib/types";

async function main() {
  const userId = "local";
  const fourteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  
  const sql = `
    SELECT * FROM trade_proposals
    WHERE created_at > ?
      AND account_number = 'VA93389646'
      AND status IN ('blocked', 'rejected')
      AND decision LIKE '%staleness%'
  `;
  const rows = db.prepare(sql).all(fourteenDaysAgo) as any[];
  
  console.log(`Found ${rows.length} blocked/rejected proposals due to staleness on VA93389646.`);

  for (const row of rows) {
    if (row.status === "placed") continue;

    let proposal;
    try {
      proposal = JSON.parse(row.proposal);
    } catch (e) {
      console.error(`Failed to parse proposal JSON for ${row.id}`, e);
      continue;
    }

    // the user only requested to place BUY limit orders
    if (proposal.side !== "buy") {
       console.log(`Skipping ${row.id} because side is ${proposal.side}`);
       continue;
    }

    console.log(`\nProcessing proposal ${row.id} for ${proposal.symbol}`);
    
    const acc = db.prepare("SELECT * FROM connected_accounts WHERE account_number = ? AND user_id = ?").get(row.account_number, userId) as any;
    if (!acc) {
      console.log(`Skipping ${row.id} - account ${row.account_number} not found in DB`);
      continue;
    }
    
    if (acc.broker !== "tradier") {
      console.log(`Skipping ${row.id} - account ${acc.account_number} is not a tradier account (${acc.broker})`);
      continue;
    }

    const gateway = getTradierGateway(acc.user_id, acc.id);
    
    const orderInput: EquityOrderInput & { refId: string } = {
      accountNumber: acc.account_number,
      symbol: proposal.symbol,
      side: proposal.side,
      quantity: proposal.quantity,
      dollarAmount: proposal.dollarAmount,
      limitPrice: proposal.limitPrice ?? proposal.referencePrice,
      timeInForce: "gtc",
      type: "limit",
      refId: row.id,
      marketHours: 'regular_hours'
    };

    console.log(`Attempting to place limit order on Tradier for ${proposal.symbol} via account ${acc.account_number}`);

    try {
      const execOrder = await gateway.placeEquityOrder(orderInput);
      console.log(`Placed successfully! Order ID: ${execOrder.orderId}`);
      db.prepare(`UPDATE trade_proposals SET status = 'placed', broker_order_id = ? WHERE id = ?`).run(execOrder.orderId, row.id);
    } catch (err: any) {
      console.error(`Failed to place order for ${proposal.symbol}: ${err.message}`);
    }
  }
}

main().catch(console.error);
