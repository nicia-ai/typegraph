import { type IntegrationStore } from "./fixtures";

export async function seedAggregateProducts(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Product.create({
    name: "Laptop",
    price: 1200,
    category: "Electronics",
    inStock: true,
    rating: 4.5,
  });
  await store.nodes.Product.create({
    name: "Phone",
    price: 800,
    category: "Electronics",
    inStock: true,
    rating: 4.2,
  });
  await store.nodes.Product.create({
    name: "Tablet",
    price: 500,
    category: "Electronics",
    inStock: false,
    rating: 3.8,
  });
  await store.nodes.Product.create({
    name: "Desk",
    price: 300,
    category: "Furniture",
    inStock: true,
    rating: 4,
  });
  await store.nodes.Product.create({
    name: "Chair",
    price: 150,
    category: "Furniture",
    inStock: true,
    rating: 4.3,
  });
}

export async function seedAdvancedAggregateProducts(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Product.create({
    name: "Laptop Pro",
    price: 1500,
    category: "Electronics",
    inStock: true,
    rating: 4.5,
  });
  await store.nodes.Product.create({
    name: "Budget Laptop",
    price: 800,
    category: "Electronics",
    inStock: true,
    rating: 3.8,
  });
  await store.nodes.Product.create({
    name: "Tablet",
    price: 600,
    category: "Electronics",
    inStock: false,
    // No rating (NULL)
  });
  await store.nodes.Product.create({
    name: "Office Desk",
    price: 400,
    category: "Furniture",
    inStock: true,
    rating: 4.2,
  });
  await store.nodes.Product.create({
    name: "Chair",
    price: 200,
    category: "Furniture",
    inStock: true,
    // No rating (NULL)
  });
  await store.nodes.Product.create({
    name: "Lamp",
    price: 50,
    category: "Furniture",
    inStock: false,
    rating: 4,
  });
}

export async function seedPeopleForComplexPredicates(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Person.create({
    name: "Alice",
    age: 30,
    email: "alice@example.com",
    isActive: true,
  });
  await store.nodes.Person.create({
    name: "Bob",
    age: 25,
    email: "bob@example.com",
    isActive: false,
  });
  await store.nodes.Person.create({
    name: "Charlie",
    age: 35,
    email: "charlie@test.com",
    isActive: true,
  });
  await store.nodes.Person.create({
    name: "Diana",
    age: 28,
    isActive: true,
  });
}

export async function seedPeopleForOrderingWithNulls(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Person.create({ name: "Alice", age: 30 });
  await store.nodes.Person.create({ name: "Bob" }); // no age
  await store.nodes.Person.create({ name: "Charlie", age: 25 });
  await store.nodes.Person.create({ name: "Diana" }); // no age
  await store.nodes.Person.create({ name: "Eve", age: 35 });
}

export async function seedPeopleForOrderByNullHandling(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Person.create({
    name: "Alice",
    age: 30,
    email: "alice@example.com",
  });
  await store.nodes.Person.create({
    name: "Bob",
    age: 25,
    // No email
  });
  await store.nodes.Person.create({
    name: "Charlie",
    // No age
    email: "charlie@example.com",
  });
  await store.nodes.Person.create({
    name: "Diana",
    age: 35,
    email: "diana@example.com",
  });
  await store.nodes.Person.create({
    name: "Eve",
    // No age, no email
  });
}

export async function seedCompaniesForSetOperations(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Company.create({
    name: "TechCorp",
    industry: "Tech",
  });
  await store.nodes.Company.create({ name: "DataInc", industry: "Tech" });
  await store.nodes.Company.create({
    name: "BioMed",
    industry: "Healthcare",
  });
  await store.nodes.Company.create({
    name: "HealthFirst",
    industry: "Healthcare",
  });
  await store.nodes.Company.create({
    name: "FinanceHub",
    industry: "Finance",
  });
}

export async function seedPeopleForStringPredicates(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Person.create({
    name: "Alice Johnson",
    email: "alice@example.com",
  });
  await store.nodes.Person.create({
    name: "Bob Smith",
    email: "bob@test.org",
  });
  await store.nodes.Person.create({
    name: "CHARLIE BROWN",
    email: "charlie@Example.COM",
  });
  await store.nodes.Person.create({
    name: "diana prince",
    email: "diana@sample.net",
  });
  await store.nodes.Person.create({
    name: "Eve Adams",
    email: "eve.adams@example.com",
  });
}

export async function seedKnowsChain(store: IntegrationStore): Promise<void> {
  // Create a chain of people who know each other:
  // Alice -> Bob -> Charlie -> Diana -> Eve
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const charlie = await store.nodes.Person.create({ name: "Charlie" });
  const diana = await store.nodes.Person.create({ name: "Diana" });
  const eve = await store.nodes.Person.create({ name: "Eve" });

  await store.edges.knows.create(alice, bob, { since: "2020" });
  await store.edges.knows.create(bob, charlie, { since: "2021" });
  await store.edges.knows.create(charlie, diana, { since: "2022" });
  await store.edges.knows.create(diana, eve, { since: "2023" });

  // Add a branch: Alice also knows Charlie directly
  await store.edges.knows.create(alice, charlie, { since: "2019" });
}

export async function seedPeopleForRecursiveDepthTracking(
  store: IntegrationStore,
): Promise<void> {
  // Create an organizational hierarchy:
  // CEO -> VP1 -> Manager1 -> Employee1
  //     -> VP2 -> Manager2
  const ceo = await store.nodes.Person.create({ name: "CEO" });
  const vp1 = await store.nodes.Person.create({ name: "VP1" });
  const vp2 = await store.nodes.Person.create({ name: "VP2" });
  const manager1 = await store.nodes.Person.create({ name: "Manager1" });
  const manager2 = await store.nodes.Person.create({ name: "Manager2" });
  const employee1 = await store.nodes.Person.create({
    name: "Employee1",
  });

  // CEO knows (manages) VP1 and VP2
  await store.edges.knows.create(ceo, vp1, { since: "2020" });
  await store.edges.knows.create(ceo, vp2, { since: "2020" });

  // VP1 knows Manager1
  await store.edges.knows.create(vp1, manager1, { since: "2021" });

  // VP2 knows Manager2
  await store.edges.knows.create(vp2, manager2, { since: "2021" });

  // Manager1 knows Employee1
  await store.edges.knows.create(manager1, employee1, { since: "2022" });
}

export async function seedProductsForCursorPagination(
  store: IntegrationStore,
): Promise<void> {
  // Create 10 products with sequential prices for predictable ordering
  for (let index = 1; index <= 10; index++) {
    await store.nodes.Product.create({
      name: `Product ${index}`,
      price: index * 100,
      category: index <= 5 ? "CategoryA" : "CategoryB",
    });
  }
}

export async function seedDocumentsForArrayPredicates(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Document.create({
    title: "Doc 1",
    tags: ["typescript", "testing", "backend"],
    scores: [90, 95, 85],
  });
  await store.nodes.Document.create({
    title: "Doc 2",
    tags: ["typescript", "frontend"],
    scores: [70, 75],
  });
  await store.nodes.Document.create({
    title: "Doc 3",
    tags: ["python", "ml"],
    scores: [100],
  });
  await store.nodes.Document.create({
    title: "Doc 4",
    tags: [],
    scores: [],
  });
  await store.nodes.Document.create({
    title: "Doc 5",
    // No tags or scores (undefined)
  });
}

export async function seedDocumentsForObjectPredicates(
  store: IntegrationStore,
): Promise<void> {
  await store.nodes.Document.create({
    title: "Published Doc",
    metadata: {
      author: "Alice",
      version: 2,
      flags: { published: true, archived: false },
    },
  });
  await store.nodes.Document.create({
    title: "Draft Doc",
    metadata: {
      author: "Bob",
      version: 1,
      flags: { published: false, archived: false },
    },
  });
  await store.nodes.Document.create({
    title: "Archived Doc",
    metadata: {
      author: "Alice",
      version: 3,
      flags: { published: true, archived: true },
    },
  });
  await store.nodes.Document.create({
    title: "No Metadata Doc",
    // No metadata
  });
}

export async function seedPeopleCompaniesForOptionalTraversals(
  store: IntegrationStore,
): Promise<void> {
  // Create people, some with companies, some without
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  // Charlie and Diana have no employer (created but not assigned to edges)
  await store.nodes.Person.create({ name: "Charlie" });
  await store.nodes.Person.create({ name: "Diana" });

  const acme = await store.nodes.Company.create({
    name: "Acme Corp",
    industry: "Tech",
  });
  const globex = await store.nodes.Company.create({
    name: "Globex",
    industry: "Finance",
  });

  // Alice works at Acme, Bob works at Globex
  // Charlie and Diana have no employer
  await store.edges.worksAt.create(alice, acme, {
    role: "Engineer",
    salary: 100_000,
  });
  await store.edges.worksAt.create(bob, globex, {
    role: "Analyst",
    salary: 80_000,
  });
}

export async function seedPeopleCompaniesForMultiHopTraversals(
  store: IntegrationStore,
): Promise<void> {
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const charlie = await store.nodes.Person.create({ name: "Charlie" });

  const acme = await store.nodes.Company.create({
    name: "Acme Corp",
    industry: "Tech",
  });
  const globex = await store.nodes.Company.create({
    name: "Globex",
    industry: "Finance",
  });

  // Alice works at Acme, Bob works at Globex
  await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
  await store.edges.worksAt.create(bob, globex, { role: "Analyst" });

  // Alice knows Bob, Bob knows Charlie
  await store.edges.knows.create(alice, bob, { since: "2020" });
  await store.edges.knows.create(bob, charlie, { since: "2021" });
}

export async function seedPeopleCompaniesForEdgePropertySelection(
  store: IntegrationStore,
): Promise<void> {
  // Create people and companies
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const charlie = await store.nodes.Person.create({ name: "Charlie" });
  // Diana has no employer (created but not assigned to edges)
  await store.nodes.Person.create({ name: "Diana" });

  const acme = await store.nodes.Company.create({
    name: "Acme Corp",
    industry: "Tech",
  });
  const globex = await store.nodes.Company.create({
    name: "Globex",
    industry: "Finance",
  });

  // Create edges with properties
  await store.edges.worksAt.create(alice, acme, {
    role: "Engineer",
    salary: 120_000,
  });
  await store.edges.worksAt.create(bob, globex, {
    role: "Analyst",
    salary: 80_000,
  });
  await store.edges.worksAt.create(charlie, acme, {
    role: "Manager",
    salary: 150_000,
  });
}

export async function seedMultiHopEdgePropertiesFixture(
  store: IntegrationStore,
): Promise<void> {
  // Create people
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const charlie = await store.nodes.Person.create({ name: "Charlie" });

  // Create companies
  const acme = await store.nodes.Company.create({
    name: "Acme Corp",
    industry: "Tech",
  });
  const globex = await store.nodes.Company.create({
    name: "Globex",
    industry: "Finance",
  });

  // Alice knows Bob, Bob knows Charlie
  await store.edges.knows.create(alice, bob, { since: "2020-01-01" });
  await store.edges.knows.create(bob, charlie, { since: "2021-06-15" });

  // Bob works at Acme, Charlie works at Globex
  await store.edges.worksAt.create(bob, acme, {
    role: "Engineer",
    salary: 100_000,
  });
  await store.edges.worksAt.create(charlie, globex, {
    role: "Manager",
    salary: 150_000,
  });
}

export async function seedWorksAtEdgesWithOptionalSalary(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Engineer", salary: 100_000 },
      { personName: "Bob", role: "Intern" },
      { personName: "Charlie", role: "Manager", salary: 150_000 },
    ],
  );
}

export async function seedWorksAtEdgesForInNotIn(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Engineer", salary: 100_000 },
      { personName: "Bob", role: "Manager", salary: 120_000 },
      { personName: "Charlie", role: "Analyst", salary: 80_000 },
      { personName: "Diana", role: "Director", salary: 200_000 },
    ],
  );
}

export async function seedWorksAtEdgesForSalaryBetween(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Junior", salary: 60_000 },
      { personName: "Bob", role: "Mid", salary: 90_000 },
      { personName: "Charlie", role: "Senior", salary: 120_000 },
      { personName: "Diana", role: "Lead", salary: 150_000 },
    ],
  );
}

export async function seedWorksAtEdgesForBackwardTraversal(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Engineer", salary: 100_000 },
      { personName: "Bob", role: "Manager", salary: 150_000 },
      { personName: "Charlie", role: "Intern", salary: 40_000 },
    ],
  );
}

export async function seedWorksAtEdgesForMultipleWhereEdge(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Engineer", salary: 100_000 },
      { personName: "Bob", role: "Engineer", salary: 80_000 },
      { personName: "Charlie", role: "Manager", salary: 150_000 },
      { personName: "Diana", role: "Manager", salary: 90_000 },
    ],
  );
}

export async function seedWorksAtEdgesForStringOperators(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Senior Engineer", salary: 150_000 },
      { personName: "Bob", role: "Junior Engineer", salary: 80_000 },
      { personName: "Charlie", role: "Engineering Manager", salary: 180_000 },
      { personName: "Diana", role: "Product Designer", salary: 120_000 },
    ],
  );
}

export async function seedWorksAtEdgesForNumberOperators(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Engineer", salary: 100_000 },
      { personName: "Bob", role: "Manager", salary: 150_000 },
      { personName: "Charlie", role: "Intern", salary: 50_000 },
    ],
  );
}

export async function seedWorksAtEdgesForPredicateCombinators(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Engineer", salary: 120_000 },
      { personName: "Bob", role: "Manager", salary: 150_000 },
      { personName: "Charlie", role: "Designer", salary: 100_000 },
      { personName: "Diana", role: "Intern", salary: 40_000 },
    ],
  );
}

export async function seedWorksAtEdgesWithNullSalaryValues(
  store: IntegrationStore,
): Promise<void> {
  await seedWorksAtEdgesForCompany(
    store,
    { name: "Acme Corp", industry: "Tech" },
    [
      { personName: "Alice", role: "Engineer", salary: 100_000 },
      { personName: "Bob", role: "Intern" },
      { personName: "Charlie", role: "Volunteer" },
    ],
  );
}

type WorksAtEmployeeSeed = Readonly<{
  personName: string;
  role: string;
  salary?: number;
}>;

async function seedWorksAtEdgesForCompany(
  store: IntegrationStore,
  company: Readonly<{ name: string; industry?: string }>,
  employees: readonly WorksAtEmployeeSeed[],
): Promise<void> {
  const createdCompany = await store.nodes.Company.create({
    name: company.name,
    industry: company.industry,
  });

  for (const employee of employees) {
    const person = await store.nodes.Person.create({
      name: employee.personName,
    });
    const edgeProps =
      employee.salary === undefined ?
        { role: employee.role }
      : { role: employee.role, salary: employee.salary };
    await store.edges.worksAt.create(person, createdCompany, edgeProps);
  }
}
