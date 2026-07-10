const withIdAlias = (record) => {
  if (!record || typeof record !== 'object') return record;
  return { ...record, _id: record.id };
};

const withIdAliases = (records) => records.map(withIdAlias);

module.exports = {
  withIdAlias,
  withIdAliases,
};
