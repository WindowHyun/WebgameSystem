'use strict';

/** 후보 하나. tags는 힌트가 판단에 쓰는 특징이고, 화면에는 나가지 않는다. */
class Candidate {
  constructor({ id, name, category, parents, tags }) {
    this.id = id;
    this.name = name;
    this.category = category;
    this.parents = parents || [];
    this.tags = tags || [];
    this.removed = false;
  }
}

module.exports = { Candidate };
