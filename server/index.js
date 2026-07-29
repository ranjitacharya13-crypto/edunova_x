export async function getServerSideProps(context) {
	const client = await clientPromise;
	const isConnected = await client.isConnected();
	const db = client.db("edunova_x");
	const collection = db.collection("edu_x collection");
	const products = await collection.find({}).toArray();
	return {
		props: {
			isConnected,
			products: JSON.parse(JSON.stringify(products))
		}
	};
}