
interface Transaction {
  id: string;
  amount: number;
  userName: string;
}

function detectFraud(transaction: Transaction) {
  const FRAUD_LIMIT = 100000;

  if (transaction.amount > FRAUD_LIMIT) {
    return {
      transactionId: transaction.id,
      status: "Suspicious",
      riskScore: 90,
      notification: `Alert! Suspicious transaction detected for ${transaction.userName}`,
    };
  }

  return {
    transactionId: transaction.id,
    status: "Normal",
    riskScore: 10,
    notification: "Transaction looks normal.",
  };
}

// Demo Transaction
const transaction = {
  id: "TXN-001",
  amount: 150000,
  userName: "Fahim",
};

console.log(detectFraud(transaction));
